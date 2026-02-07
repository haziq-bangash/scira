import 'server-only';

import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import { Runnable, RunnableConfig } from '@langchain/core/runnables';
import { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface PageContent {
  pageNumber: number;
  content: string;
}

export interface DocumentNode {
  node_id: string;
  title: string;
  /** Summary for leaf nodes (generated from full content) */
  summary: string;
  /** Summary for parent/non-leaf nodes (generated from the node's own header text, excluding children) */
  prefix_summary?: string;
  /** Hierarchical structure index (e.g., "1", "1.1", "1.1.2") */
  structure_index?: string;
  start_index: number;
  end_index: number;
  /**
   * Full text content for leaf nodes.
   * Prefix-only text for parent nodes (pages before first child).
   * After indexing, full text can be reconstructed via getFullNodeText().
   */
  text?: string;
  /** Approximate token count for this node's subtree (prefix + all descendants) */
  text_token_count?: number;
  nodes: DocumentNode[];
}

export interface DocumentIndex {
  doc_name: string;
  doc_description?: string;
  total_pages: number;
  structure: DocumentNode[];
}

export interface PageIndexConfig {
  maxPagesPerNode: number;
  maxTokensPerNode: number;
  tocCheckPages: number;
  addNodeSummary: boolean;
  addNodeText: boolean;
  /** Minimum token count per node — nodes below this threshold are merged into parent (tree thinning) */
  minNodeTokens: number;
  /** Token threshold below which the node text is used directly as summary instead of LLM generation */
  summaryTokenThreshold: number;
  /** Enable tree thinning to merge small nodes into parents */
  enableTreeThinning: boolean;
  /** Enable ToC verification to check that section titles appear on their assigned pages */
  enableTocVerification: boolean;
  /** Maximum attempts to fix incorrect ToC entries */
  maxTocFixAttempts: number;
  /** Maximum tokens to include in retrieved context (prevents exceeding LLM context window) */
  maxContextTokens: number;
}

const DEFAULT_CONFIG: PageIndexConfig = {
  maxPagesPerNode: 10,
  maxTokensPerNode: 20000,
  tocCheckPages: 20,
  addNodeSummary: true,
  addNodeText: true,
  minNodeTokens: 5000,
  summaryTokenThreshold: 200,
  enableTreeThinning: false,
  enableTocVerification: true,
  maxTocFixAttempts: 3,
  maxContextTokens: 30000,
};

// =============================================================================
// ZOD SCHEMAS FOR STRUCTURED OUTPUT
// =============================================================================

const TocDetectionSchema = z.object({
  has_toc: z.boolean().describe('Whether the document has a Table of Contents'),
  toc_entries: z
    .array(
      z.object({
        title: z.string().describe('Section title from the ToC'),
        page: z.number().nullable().describe('Page number for this section, or null if not present'),
        level: z.number().describe('Heading level (1 = top-level, 2 = subsection, etc.)'),
        structure_index: z
          .string()
          .nullable()
          .describe('Hierarchical index like 1, 1.1, 1.2, 2, etc., or null if not numbered'),
      }),
    )
    .describe('Extracted ToC entries if a ToC exists'),
  page_numbers_present: z.boolean().describe('Whether the ToC includes page numbers for sections'),
});

// Recursive Zod schema for DocumentNode using z.lazy
const DocumentNodeSchema: z.ZodType<DocumentNode> = z.lazy(() =>
  z.object({
    node_id: z.string().describe('Unique identifier (e.g., 0001, 0002)'),
    title: z.string().describe('Section title'),
    summary: z.string().describe('Brief summary of what this section contains'),
    structure_index: z.string().optional().describe('Hierarchical index (e.g., 1, 1.1, 1.2)'),
    start_index: z.number().describe('Start page number'),
    end_index: z.number().describe('End page number'),
    nodes: z.array(DocumentNodeSchema).describe('Child nodes (recursive structure)'),
  }),
);

const DocumentIndexSchema = z.object({
  doc_name: z.string().describe('Document name'),
  doc_description: z.string().optional().describe('Brief description of the entire document'),
  structure: z.array(DocumentNodeSchema).describe('Top-level document structure nodes'),
});

const TreeSearchResultSchema = z.object({
  thinking: z.string().describe('Step-by-step reasoning about where to find the answer in the document'),
  node_list: z.array(z.string()).describe('List of node_ids most likely to contain the answer'),
  needs_more_context: z.boolean().describe('Whether additional sections need to be consulted'),
  cross_references: z.array(z.string()).describe('Referenced sections that should also be checked'),
});

const TitleVerificationSchema = z.object({
  thinking: z.string().describe('Reasoning about whether the section title appears on the page'),
  answer: z.enum(['yes', 'no']).describe('Whether the section title appears or starts on this page'),
});

const NodeSummarySchema = z.object({
  summary: z.string().describe('A concise 1-3 sentence summary of what this section contains'),
});

const TocPhysicalIndexSchema = z.object({
  entries: z.array(
    z.object({
      title: z.string().describe('Section title'),
      structure_index: z.string().nullable().describe('Hierarchical index'),
      physical_index: z.number().nullable().describe('Physical page number where the section starts'),
    }),
  ),
});

const ChunkTocEntrySchema = z.object({
  entries: z
    .array(
      z.object({
        structure_index: z.string().describe('Hierarchical index (e.g., 1, 1.1, 1.2, 2)'),
        title: z.string().describe('Section title extracted from the text'),
        physical_index: z.number().describe('Physical page number where the section starts'),
        level: z.number().describe('Heading level (1 = top-level, 2 = subsection, etc.)'),
      }),
    )
    .describe('Flat list of ToC entries extracted from this chunk'),
});

const FixEntrySchema = z.object({
  thinking: z.string().describe('Reasoning about where the section starts'),
  physical_index: z
    .number()
    .nullable()
    .describe('Corrected physical page number where the section starts, or null if not found'),
});

type TocDetectionResult = z.infer<typeof TocDetectionSchema>;
type TreeSearchResult = z.infer<typeof TreeSearchResultSchema>;

// =============================================================================
// PAGEINDEX RAG CLASS
// =============================================================================

export class PageIndexRAG {
  private llm: ChatOpenAI;
  private config: PageIndexConfig;
  private documentIndex: DocumentIndex | null = null;
  private nodeMap: Map<string, DocumentNode> = new Map();

  private structuredTocDetector: Runnable<BaseLanguageModelInput, TocDetectionResult, RunnableConfig>;

  private structuredTreeGenerator: Runnable<
    BaseLanguageModelInput,
    { doc_name: string; doc_description?: string; structure: DocumentNode[] },
    RunnableConfig
  >;

  private structuredTreeSearcher: Runnable<BaseLanguageModelInput, TreeSearchResult, RunnableConfig>;

  private structuredTitleVerifier: Runnable<
    BaseLanguageModelInput,
    z.infer<typeof TitleVerificationSchema>,
    RunnableConfig
  >;

  private structuredSummaryGenerator: Runnable<
    BaseLanguageModelInput,
    z.infer<typeof NodeSummarySchema>,
    RunnableConfig
  >;

  private structuredTocPhysicalIndexer: Runnable<
    BaseLanguageModelInput,
    z.infer<typeof TocPhysicalIndexSchema>,
    RunnableConfig
  >;

  private structuredChunkTocGenerator: Runnable<
    BaseLanguageModelInput,
    z.infer<typeof ChunkTocEntrySchema>,
    RunnableConfig
  >;

  private structuredFixEntryGenerator: Runnable<BaseLanguageModelInput, z.infer<typeof FixEntrySchema>, RunnableConfig>;

  private titleIndex: Map<string, DocumentNode> = new Map();
  private structureIndexMap: Map<string, DocumentNode> = new Map();

  constructor(config: Partial<PageIndexConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set.');
    }

    this.llm = new ChatOpenAI({
      model: 'gpt-4.1',
      apiKey: process.env.OPENAI_API_KEY,
    });

    if (!this.llm) {
        throw new Error('Failed to initialize language model. Check your configuration and API key.');
    }

    this.structuredTocDetector = this.llm.withStructuredOutput(TocDetectionSchema, { name: 'toc_detector' });

    // z.lazy breaks z.infer (resolves recursive DocumentNode to unknown), so assert the correct type
    this.structuredTreeGenerator = this.llm.withStructuredOutput(DocumentIndexSchema, {
      name: 'tree_generator',
    }) as typeof this.structuredTreeGenerator;

    this.structuredTreeSearcher = this.llm.withStructuredOutput(TreeSearchResultSchema, { name: 'tree_searcher' });

    this.structuredTitleVerifier = this.llm.withStructuredOutput(TitleVerificationSchema, { name: 'title_verifier' });

    this.structuredSummaryGenerator = this.llm.withStructuredOutput(NodeSummarySchema, { name: 'summary_generator' });

    this.structuredTocPhysicalIndexer = this.llm.withStructuredOutput(TocPhysicalIndexSchema, {
      name: 'toc_physical_indexer',
    });

    this.structuredChunkTocGenerator = this.llm.withStructuredOutput(ChunkTocEntrySchema, {
      name: 'chunk_toc_generator',
    });

    this.structuredFixEntryGenerator = this.llm.withStructuredOutput(FixEntrySchema, { name: 'fix_entry_generator' });
  }

  // ===========================================================================
  // PHASE 1: INDEX GENERATION
  // ===========================================================================

  async indexDocument(pages: PageContent[], documentName: string): Promise<DocumentIndex> {
    if (pages.length === 0) {
      throw new Error('No pages provided for indexing.');
    }

    console.log('Page Index started', pages.length);

    // 1. Check for existing ToC
    const tocResult = await this.detectTableOfContents(pages);

    console.log(tocResult);

    // 2. Generate hierarchical tree structure
    let tree: DocumentIndex;

    if (tocResult.has_toc && tocResult.page_numbers_present) {
      // ToC with page numbers — use page offset calculation
      tree = await this.generateTreeFromTocWithPageNumbers(pages, tocResult, documentName);
    } else if (tocResult.has_toc) {
      // ToC without page numbers — find physical page indices
      tree = await this.generateTreeFromTocWithoutPageNumbers(pages, tocResult, documentName);
    } else {
      // No ToC — generate structure from content (chunked for large docs)
      tree = await this.generateTreeStructure(pages, documentName);
    }

    console.log('tree structure generating', tree.structure.length);

    // 3. Attach full text content to all nodes (parents get full text for summaries)
    this.attachTextToNodes(tree, pages);

    console.log('nodes attached');

    // 4. Tree thinning — merge small nodes into parents
    if (this.config.enableTreeThinning) {
      this.thinTree(tree);
    }
    console.log('tree thinned');

    // 5. Generate per-node summaries (parallel, uses full text on all nodes)
    if (this.config.addNodeSummary) {
      await this.generateNodeSummaries(tree);
    }

    console.log('node summaries generated');

    // 6. Verify ToC entries appear on assigned pages
    if (this.config.enableTocVerification && pages.length > 1) {
      await this.verifyAndFixToc(tree, pages, documentName);
    }
    console.log('ToC verification complete');

    // 7. Convert parent nodes to prefix-only text (saves memory)
    //    Full text can be reconstructed via getFullNodeText() during queries.
    this.convertParentsToPrefixText(tree, pages);

    // 8. Optionally strip text from nodes to save space
    if (!this.config.addNodeText) {
      this.stripTextFromNodes(tree);
    }
    console.log('node text stripped');

    // 9. Assign structure indices
    this.assignStructureIndices(tree.structure);
    console.log('structure indices assigned');

    // 10. Store index and build node map
    this.documentIndex = tree;
    this.documentIndex.total_pages = pages.length;
    this.nodeMap = this.createNodeMapping(tree);

    console.log('Indexing complete', {
      totalPages: pages.length,
      totalNodes: this.nodeMap.size,
    });

    return this.documentIndex;
  }

  // ===========================================================================
  // PHASE 2: TREE SEARCH RETRIEVAL
  // ===========================================================================

  async query(question: string): Promise<{ answer: string; context: string }> {
    if (!this.documentIndex) {
      throw new Error('No document indexed. Call indexDocument() first.');
    }

    const context = await this.iterativeTreeSearch(question);
    console.log('Context retrieved for question:', { question, context });
    const answer = await this.generateAnswer(question, context);

    return { answer, context };
  }

  /**
   * Retrieves relevant context for a given question without generating an answer.
   * Useful when the answer generation is handled externally (e.g., by a chat agent).
   */
  async retrieveContext(question: string): Promise<string> {
    if (!this.documentIndex) {
      throw new Error('No document indexed. Call indexDocument() first.');
    }

    return this.iterativeTreeSearch(question);
  }

  // ===========================================================================
  // INDEX PERSISTENCE
  // ===========================================================================

  loadIndex(indexJson: DocumentIndex): void {
    this.documentIndex = indexJson;
    this.nodeMap = this.createNodeMapping(indexJson);
  }

  /**
   * Loads a persisted index and re-attaches page text to leaf nodes
   * that had their text stripped (addNodeText: false).
   * If leaf nodes already have text, this is a no-op for those nodes.
   */
  loadIndexWithPages(indexJson: DocumentIndex, pages: PageContent[]): void {
    this.loadIndex(indexJson);

    const pageMap = new Map<number, string>();
    for (const p of pages) {
      pageMap.set(p.pageNumber, p.content);
    }

    const attachText = (node: DocumentNode) => {
      if (node.nodes.length === 0) {
        // Leaf node — re-attach text if missing
        if (!node.text) {
          const texts: string[] = [];
          for (let i = node.start_index; i <= node.end_index; i++) {
            const content = pageMap.get(i);
            if (content) texts.push(content);
          }
          node.text = texts.join('\n\n');
          node.text_token_count = this.estimateTokens(node.text);
        }
      } else {
        // Parent node — re-attach prefix text if missing, then recurse
        if (!node.text) {
          const firstChildStart = Math.min(...node.nodes.map((c) => c.start_index));
          if (firstChildStart > node.start_index) {
            const texts: string[] = [];
            for (let i = node.start_index; i < firstChildStart; i++) {
              const content = pageMap.get(i);
              if (content) texts.push(content);
            }
            node.text = texts.join('\n\n');
          } else {
            node.text = '';
          }
        }
        node.nodes.forEach(attachText);
      }
    };

    indexJson.structure.forEach(attachText);
  }

  exportIndex(): DocumentIndex | null {
    return this.documentIndex;
  }

  getNodeMap(): Map<string, DocumentNode> {
    return this.nodeMap;
  }

  // ===========================================================================
  // CLEANUP
  // ===========================================================================

  /**
   * Releases all references held by this instance.
   * Call this when done with the RAG instance to allow GC to reclaim memory.
   */
  dispose(): void {
    this.documentIndex = null;
    this.nodeMap.clear();
    this.titleIndex.clear();
    this.structureIndexMap.clear();
    this.structuredTocDetector = null as unknown as typeof this.structuredTocDetector;
    this.structuredTreeGenerator = null as unknown as typeof this.structuredTreeGenerator;
    this.structuredTreeSearcher = null as unknown as typeof this.structuredTreeSearcher;
    this.structuredTitleVerifier = null as unknown as typeof this.structuredTitleVerifier;
    this.structuredSummaryGenerator = null as unknown as typeof this.structuredSummaryGenerator;
    this.structuredTocPhysicalIndexer = null as unknown as typeof this.structuredTocPhysicalIndexer;
    this.structuredChunkTocGenerator = null as unknown as typeof this.structuredChunkTocGenerator;
    this.structuredFixEntryGenerator = null as unknown as typeof this.structuredFixEntryGenerator;
    this.llm = null as unknown as typeof this.llm;
  }

  // ===========================================================================
  // PRIVATE: UTILITIES
  // ===========================================================================

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Reconstructs full text for a node.
   * - Leaf nodes: returns node.text directly.
   * - Parent nodes: returns prefix text + all descendants' text.
   * Uses visited set to prevent duplicate extraction when multiple selected nodes overlap.
   */
  private getFullNodeText(node: DocumentNode, visited: Set<string>): string {
    visited.add(node.node_id);

    if (node.nodes.length === 0) {
      return node.text || '';
    }

    // Parent node: prefix text + children's text
    let text = node.text || '';
    for (const child of node.nodes) {
      if (visited.has(child.node_id)) continue;
      const childText = this.getFullNodeText(child, visited);
      if (childText) {
        if (text && !text.endsWith('\n')) {
          text += '\n\n';
        }
        text += childText;
      }
    }

    return text;
  }

  // ===========================================================================
  // PRIVATE: TOC DETECTION
  // ===========================================================================

  private async detectTableOfContents(pages: PageContent[]): Promise<TocDetectionResult> {
    const checkPages = pages.slice(0, this.config.tocCheckPages);
    const pagesText = checkPages.map((p) => `--- Page ${p.pageNumber} ---\n${p.content}`).join('\n\n');

    const system = new SystemMessage(
      `You are a document structure analyzer. Analyze the provided pages and determine if they contain a Table of Contents (ToC).

If a ToC exists, extract ALL entries with:
- title: The section title exactly as it appears
- page: The page number (or null if not present)
- level: The heading depth (1 = chapter, 2 = section, 3 = subsection)
- structure_index: The hierarchical numbering (e.g., "1", "1.1", "1.2", "2", "2.1")

CRITICAL for structure_index:
- "1 Introduction" → structure_index: "1"
- "1.1 Polynomial Curve Fitting" → structure_index: "1.1"
- "1.2 Probability Theory" → structure_index: "1.2"
- "1.2.1 Probability densities" → structure_index: "1.2.1"
- "2 Probability Distributions" → structure_index: "2"
- "Preface" (no number) → structure_index: null
- "Appendix A" → structure_index: "A"

The structure_index is the numeric/letter prefix of the section. Extract it exactly as shown in the ToC.

Important:
- Extract ALL ToC entries, not just a sample
- Only report a ToC if you find a clearly formatted table of contents section
- Do not infer a ToC from section headings in the body text
- Abstract, summary, notation lists, figure lists, and table lists are NOT tables of contents
- Set page_numbers_present to true only if the ToC explicitly includes page numbers`,
    );

    const human = new HumanMessage(
      `Analyze the following pages and extract the complete Table of Contents:\n\n${pagesText}`,
    );

    try {
      return await this.structuredTocDetector.invoke([system, human]);
    } catch (error) {
      console.error('[PageIndexRAG] ToC detection failed:', error);
      return {
        has_toc: false,
        toc_entries: [],
        page_numbers_present: false,
      };
    }
  }

  /**
   * Infers missing parent nodes by assigning structure indices to unnumbered entries.
   * E.g., if "1.1" exists but "1" doesn't, finds the closest unnumbered entry before "1.1"
   * and assigns it structure "1".
   */
  private inferMissingParents(
    flatEntries: Array<{
      structure: string | null;
      title: string;
      physical_index: number | null;
    }>,
  ): Array<{
    structure: string | null;
    title: string;
    physical_index: number | null;
  }> {
    // Collect all parent prefixes needed (e.g., "1" from "1.1", "2" from "2.3")
    const neededParents = new Set<string>();
    const existingStructures = new Set<string>();

    for (const entry of flatEntries) {
      if (entry.structure) {
        existingStructures.add(entry.structure);
        const parts = entry.structure.split('.');
        if (parts.length > 1) {
          // "1.1" needs parent "1", "1.2.3" needs "1.2" and "1"
          for (let i = 1; i < parts.length; i++) {
            neededParents.add(parts.slice(0, i).join('.'));
          }
        }
      }
    }

    // Find which parents are missing — a parent is only considered "existing"
    // if it appears BEFORE the first child that needs it. This handles documents
    // with conflicting numbering scopes (e.g., main sections 1.1-1.9 and
    // research sections 1-7 where research "1" shouldn't satisfy parent "1" for "1.1").
    const missingParents: string[] = [];
    for (const parent of Array.from(neededParents)) {
      const firstChildIdx = flatEntries.findIndex((e) => e.structure && e.structure.startsWith(parent + '.'));
      if (firstChildIdx === -1) continue; // No children found — skip
      const parentExistsBefore = flatEntries.slice(0, firstChildIdx).some((e) => e.structure === parent);
      if (!parentExistsBefore) {
        missingParents.push(parent);
      }
    }

    if (missingParents.length === 0) {
      return flatEntries;
    }

    // Sort so we process top-level parents first ("1" before "1.2")
    missingParents.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const result = [...flatEntries];

    for (const missingParent of missingParents) {
      // Find the first child of this parent
      const firstChildIdx = result.findIndex((e) => e.structure && e.structure.startsWith(missingParent + '.'));

      if (firstChildIdx > 0) {
        // Look backwards for an unnumbered entry to assign as parent
        let found = false;
        for (let i = firstChildIdx - 1; i >= 0; i--) {
          if (!result[i].structure) {
            console.log(`[PageIndexRAG] Assigning structure "${missingParent}" to "${result[i].title}"`);
            result[i] = { ...result[i], structure: missingParent };
            found = true;
            break;
          }
        }
        if (!found) {
          console.warn(
            `[PageIndexRAG] No unnumbered entry found for missing parent "${missingParent}" — children will become orphan roots`,
          );
        }
      }
    }

    return result;
  }

  /**
   * Converts a flat list of ToC entries with structure indices into a hierarchical tree.
   * This is the key function that builds the tree from "1", "1.1", "1.2", "2", etc.
   */
  private postProcessingToTree(
    flatEntries: Array<{
      structure: string | null;
      title: string;
      physical_index: number | null;
    }>,
    totalPages: number,
    startIndex: number = 1,
  ): DocumentNode[] {
    if (flatEntries.length === 0) {
      return [];
    }

    // Infer missing parent nodes before building tree
    const fixedEntries = this.inferMissingParents(flatEntries);

    const rootNodes: DocumentNode[] = [];
    const nodeByStructure = new Map<string, DocumentNode>();
    const structureToFlatIdx = new Map<string, number>();
    const allNodes: Array<{ node: DocumentNode; structure: string | null }> = [];
    let nodeCounter = 1;

    // PASS 1: Create all nodes and store in map
    for (let i = 0; i < fixedEntries.length; i++) {
      const entry = fixedEntries[i];
      const physicalIndex = entry.physical_index ?? startIndex;

      // Determine end page: look ahead past null entries to find the next
      // entry with a valid physical_index. This prevents a node from spanning
      // to the end of the document just because the next entry has a null index.
      let endPage: number = totalPages + startIndex - 1;
      for (let j = i + 1; j < fixedEntries.length; j++) {
        if (fixedEntries[j].physical_index !== null) {
          endPage = fixedEntries[j].physical_index! - 1;
          break;
        }
      }

      const treeNode: DocumentNode = {
        node_id: String(nodeCounter).padStart(4, '0'),
        title: entry.title,
        summary: '',
        structure_index: entry.structure ?? undefined,
        start_index: physicalIndex,
        end_index: Math.max(physicalIndex, endPage),
        nodes: [],
      };
      nodeCounter++;

      allNodes.push({ node: treeNode, structure: entry.structure });

      // Keep first occurrence only — prevents later entries with conflicting
      // structure indices (e.g., research "1" vs inferred parent "1") from
      // overwriting the correct parent in the map.
      if (entry.structure && !nodeByStructure.has(entry.structure)) {
        nodeByStructure.set(entry.structure, treeNode);
        structureToFlatIdx.set(entry.structure, i);
      }
    }

    // PASS 2: Wire up parent-child relationships.
    // Uses positional constraint: a parent must appear before its child in
    // document order. This prevents mis-wiring when two independent sections
    // share the same structure index (e.g., inferred "1" for Recommendations
    // vs. research "1 Imaging options").
    for (let idx = 0; idx < allNodes.length; idx++) {
      const { node, structure } = allNodes[idx];
      if (!structure) {
        // Entries without structure_index are always root nodes
        rootNodes.push(node);
        continue;
      }

      const structureParts = structure.split('.');

      if (structureParts.length === 1) {
        // Top-level numbered section (e.g., "1", "2", "3")
        rootNodes.push(node);
      } else {
        // Has a parent — find it and verify it appears before this node
        const parentStructure = structureParts.slice(0, -1).join('.');
        const parentNode = nodeByStructure.get(parentStructure);
        const parentIdx = structureToFlatIdx.get(parentStructure);

        if (parentNode && parentIdx !== undefined && parentIdx < idx) {
          parentNode.nodes.push(node);
        } else {
          if (parentNode && (parentIdx === undefined || parentIdx >= idx)) {
            console.warn(
              `[PageIndexRAG] Parent "${parentStructure}" found but appears after child "${structure}" — adding as root`,
            );
          } else {
            console.warn(`[PageIndexRAG] Parent "${parentStructure}" not found for "${structure}", adding as root`);
          }
          rootNodes.push(node);
        }
      }
    }

    this.fixParentEndIndices(rootNodes);

    return rootNodes;
  }

  // ===========================================================================
  // PRIVATE: TREE FROM TOC WITH PAGE NUMBERS (Page Offset Calculation)
  // ===========================================================================

  private async generateTreeFromTocWithPageNumbers(
    pages: PageContent[],
    tocResult: TocDetectionResult,
    documentName: string,
  ): Promise<DocumentIndex> {
    const entries = tocResult.toc_entries;

    // Find physical page indices for a sample of ToC entries
    // by checking where titles actually appear in the document
    const sampleEntries = entries.slice(0, Math.min(entries.length, 10));
    const physicalIndices = await this.findPhysicalIndicesForEntries(sampleEntries, pages);

    console.log('Physical Index', physicalIndices);

    // Calculate page offset between ToC page numbers and physical page indices
    const offset = this.calculatePageOffset(sampleEntries, physicalIndices);

    console.log('Calculated page offset', offset);

    // Build the tree using ToC entries with offset-adjusted page numbers
    return this.buildTreeFromTocEntries(entries, pages, offset, documentName);
  }

  private async findPhysicalIndicesForEntries(
    entries: TocDetectionResult['toc_entries'],
    pages: PageContent[],
  ): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();

    // Chunk the content if too large
    const chunks = this.splitIntoTokenGroups(
      pages.map((p) => ({
        text: `<physical_index_${p.pageNumber}>\n${p.content}\n<physical_index_${p.pageNumber}>\n\n`,
        pageNumber: p.pageNumber,
      })),
    );

    const entriesJson = entries.map((e) => ({
      title: e.title,
      structure_index: e.structure_index,
    }));

    // Process each chunk to find physical indices
    for (const chunk of chunks) {
      const system = new SystemMessage(
        `You are given a list of section titles from a table of contents and pages of a document.
The pages contain tags like <physical_index_X> to indicate the physical page number.

Your job is to find which physical page each section starts on.
If a section does not appear in these pages, set physical_index to null.`,
      );

      const human = new HumanMessage(
        `Section titles:\n${JSON.stringify(entriesJson, null, 2)}\n\nDocument pages:\n${chunk}`,
      );

      try {
        const response = await this.structuredTocPhysicalIndexer.invoke([system, human]);

        for (const entry of response.entries) {
          if (entry.physical_index !== null && !result.has(entry.title)) {
            result.set(entry.title, entry.physical_index);
          }
        }
      } catch (error) {
        console.error('[PageIndexRAG] Physical index extraction failed for chunk:', error);
      }
    }

    return result;
  }

  private calculatePageOffset(
    tocEntries: TocDetectionResult['toc_entries'],
    physicalIndices: Map<string, number | null>,
  ): number {
    const differences: number[] = [];

    for (const entry of tocEntries) {
      if (entry.page === null) continue;
      const physicalIndex = physicalIndices.get(entry.title);
      if (physicalIndex !== null && physicalIndex !== undefined) {
        differences.push(physicalIndex - entry.page);
      }
    }

    if (differences.length === 0) return 0;

    // Find the most common offset (mode)
    const counts = new Map<number, number>();
    for (const diff of differences) {
      counts.set(diff, (counts.get(diff) || 0) + 1);
    }

    let maxCount = 0;
    let mostCommon = 0;
    for (const [diff, count] of Array.from(counts.entries())) {
      if (count > maxCount) {
        maxCount = count;
        mostCommon = diff;
      }
    }

    return mostCommon;
  }

  private buildTreeFromTocEntries(
    entries: TocDetectionResult['toc_entries'],
    pages: PageContent[],
    offset: number,
    documentName: string,
  ): DocumentIndex {
    // Convert ToC entries to flat list with physical indices
    const flatEntries = entries.map((entry) => {
      const physicalPage = entry.page !== null ? entry.page + offset : null;

      return {
        structure: entry.structure_index,
        title: entry.title,
        physical_index: physicalPage !== null ? Math.max(physicalPage, pages[0].pageNumber) : null,
      };
    });

    console.log('Flat entries before tree building:', flatEntries.length);
    console.log('First 10 entries:');
    flatEntries.slice(0, 10).forEach((e, i) => {
      console.log(`  ${i}: structure=${e.structure}, title="${e.title}", physical_index=${e.physical_index}`);
    });

    // Use post_processing to build hierarchical tree from flat list
    const structure = this.postProcessingToTree(flatEntries, pages.length, pages[0].pageNumber);

    console.log('Built tree with root nodes:', structure.length);

    return {
      doc_name: documentName,
      total_pages: pages.length,
      structure,
    };
  }

  private fixParentEndIndices(nodes: DocumentNode[]): void {
    for (const node of nodes) {
      if (node.nodes.length > 0) {
        this.fixParentEndIndices(node.nodes);
        const maxChildEnd = Math.max(...node.nodes.map((c) => c.end_index));
        node.end_index = Math.max(node.end_index, maxChildEnd);
      }
    }
  }

  // ===========================================================================
  // PRIVATE: TREE FROM TOC WITHOUT PAGE NUMBERS
  // ===========================================================================

  private async generateTreeFromTocWithoutPageNumbers(
    pages: PageContent[],
    tocResult: TocDetectionResult,
    documentName: string,
  ): Promise<DocumentIndex> {
    const entries = tocResult.toc_entries;

    // Find physical page indices by searching the document for each title
    const physicalIndices = await this.findPhysicalIndicesForEntries(entries, pages);

    // Build tree using found physical indices (offset=0 since we found physical indices directly)
    const entriesWithPages = entries.map((e) => ({
      ...e,
      page: physicalIndices.get(e.title) ?? null,
    }));

    return this.buildTreeFromTocEntries(entriesWithPages, pages, 0, documentName);
  }

  // ===========================================================================
  // PRIVATE: TREE STRUCTURE GENERATION (No ToC — chunked for large docs)
  // ===========================================================================

  private async generateTreeStructure(pages: PageContent[], documentName: string): Promise<DocumentIndex> {
    // Split pages into groups that fit within token limits
    const pageTexts = pages.map((p) => ({
      text: `<physical_index_${p.pageNumber}>\n${p.content}\n<physical_index_${p.pageNumber}>\n\n`,
      pageNumber: p.pageNumber,
    }));

    const groups = this.splitIntoTokenGroups(pageTexts);

    if (groups.length === 1) {
      // Small document — single-pass generation
      return this.generateTreeStructureSinglePass(pages, groups[0], documentName);
    }

    // Large document — sequential chunked generation
    return this.generateTreeStructureChunked(pages, groups, documentName);
  }

  private async generateTreeStructureSinglePass(pages: PageContent[], documentContent: string, documentName: string): Promise<DocumentIndex> {
    const system = new SystemMessage(
      `You are a document structure analyzer. Given the following document content, create a hierarchical tree structure (like a Table of Contents) that organizes the document into logical sections and subsections.

The provided text contains tags like <physical_index_X> to indicate the physical page number.

Requirements:
1. Each leaf node should cover at most ${this.config.maxPagesPerNode} pages
2. Create meaningful section titles based on content — extract the original title from the text
3. Write a brief summary (1-2 sentences) for each section describing what it contains
4. Preserve natural document hierarchy (chapters -> sections -> subsections)
5. Assign sequential node_ids as zero-padded 4-digit strings (0001, 0002, 0003, etc.)
6. Every page must be covered by at least one node — no gaps in page ranges
7. Page ranges of sibling nodes should not overlap
8. Use the physical_index tags to determine accurate start_index and end_index values`,
    );

    const human = new HumanMessage(
      `Create a hierarchical tree structure for this document (${pages.length} pages):\n\n${documentContent}`,
    );

    try {
      const result = await this.structuredTreeGenerator.invoke([system, human]);

      return {
        doc_name: result.doc_name,
        doc_description: result.doc_description,
        total_pages: pages.length,
        structure: result.structure,
      };
    } catch (error) {
      console.error('[PageIndexRAG] Tree generation failed:', error);
      return this.createFallbackStructure(pages);
    }
  }

  private async generateTreeStructureChunked(pages: PageContent[], groups: string[], documentName: string): Promise<DocumentIndex> {
    type ChunkTocEntry = z.infer<typeof ChunkTocEntrySchema>['entries'][number];
    let accumulatedToc: ChunkTocEntry[] = [];

    // Process first chunk — generate initial structure
    try {
      const initResult = await this.generateChunkToc(groups[0], null);
      accumulatedToc = initResult;
    } catch (error) {
      console.error('[PageIndexRAG] Initial chunk ToC generation failed:', error);
      return this.createFallbackStructure(pages);
    }

    // Process remaining chunks — continue the structure
    for (let i = 1; i < groups.length; i++) {
      try {
        const continueResult = await this.generateChunkToc(groups[i], accumulatedToc);
        accumulatedToc.push(...continueResult);
      } catch (error) {
        console.error(`[PageIndexRAG] Chunk ${i + 1} ToC generation failed:`, error);
      }
    }

    // Build tree from flat accumulated ToC entries
    return this.buildTreeFromFlatEntries(accumulatedToc, pages);
  }

  private async generateChunkToc(
    chunkText: string,
    previousToc: z.infer<typeof ChunkTocEntrySchema>['entries'] | null,
  ): Promise<z.infer<typeof ChunkTocEntrySchema>['entries']> {
    const isInitial = previousToc === null;

    const system = new SystemMessage(
      isInitial
        ? `You are an expert in extracting hierarchical tree structure. Generate the tree structure of the document.

The structure_index is the numeric system representing the hierarchy (e.g., 1, 1.1, 1.2, 2, etc.).
For the title, extract the original title from the text, only fix space inconsistency.
The text contains tags like <physical_index_X> to indicate physical page numbers.`
        : `You are an expert in extracting hierarchical tree structure.
Continue the tree structure from the previous part to include the current part.

The structure_index is the numeric system representing the hierarchy (e.g., 1, 1.1, 1.2, 2, etc.).
The text contains tags like <physical_index_X> to indicate physical page numbers.

Return ONLY the new entries (not the ones from the previous structure).`,
    );

    const humanContent = isInitial
      ? `Given text:\n${chunkText}`
      : `Previous tree structure:\n${JSON.stringify(previousToc, null, 2)}\n\nCurrent text:\n${chunkText}`;

    const human = new HumanMessage(humanContent);

    try {
      const result = await this.structuredChunkTocGenerator.invoke([system, human]);
      return result.entries;
    } catch (error) {
      console.error('[PageIndexRAG] Chunk ToC generation failed:', error);
      return [];
    }
  }

  private buildTreeFromFlatEntries(
    flatEntries: z.infer<typeof ChunkTocEntrySchema>['entries'],
    pages: PageContent[],
  ): DocumentIndex {
    if (flatEntries.length === 0) {
      return this.createFallbackStructure(pages);
    }

    // Convert to common format and use postProcessingToTree
    const entries = flatEntries.map((entry) => ({
      structure: entry.structure_index,
      title: entry.title,
      physical_index: entry.physical_index,
    }));

    const structure = this.postProcessingToTree(entries, pages.length, pages[0].pageNumber);

    return {
      doc_name: 'Document',
      total_pages: pages.length,
      structure,
    };
  }

  private createFallbackStructure(pages: PageContent[]): DocumentIndex {
    const structure: DocumentNode[] = [];
    let nodeCounter = 1;

    for (let i = 0; i < pages.length; i += this.config.maxPagesPerNode) {
      const startPage = pages[i].pageNumber;
      const endIdx = Math.min(i + this.config.maxPagesPerNode - 1, pages.length - 1);
      const endPage = pages[endIdx].pageNumber;

      structure.push({
        node_id: String(nodeCounter).padStart(4, '0'),
        title: `Section ${nodeCounter} (Pages ${startPage}-${endPage})`,
        summary: `Content from pages ${startPage} to ${endPage}.`,
        start_index: startPage,
        end_index: endPage,
        nodes: [],
      });

      nodeCounter++;
    }

    return {
      doc_name: 'Unknown Document',
      doc_description: 'Automatically generated fallback structure.',
      total_pages: pages.length,
      structure,
    };
  }

  // ===========================================================================
  // PRIVATE: CHUNKED TEXT PROCESSING
  // ===========================================================================

  private splitIntoTokenGroups(pageTexts: { text: string; pageNumber: number }[], overlapPages: number = 1): string[] {
    const maxTokens = this.config.maxTokensPerNode;

    // O(P): Estimate tokens without LLM calls
    const tokenCounts = pageTexts.map((pt) => this.estimateTokens(pt.text));
    const totalTokens = tokenCounts.reduce((a, b) => a + b, 0);

    if (totalTokens <= maxTokens) {
      return [pageTexts.map((pt) => pt.text).join('')];
    }

    // Split into groups
    const expectedParts = Math.ceil(totalTokens / maxTokens);
    const avgTokensPerPart = Math.ceil((totalTokens / expectedParts + maxTokens) / 2);

    const groups: string[] = [];
    let currentGroup: string[] = [];
    let currentTokenCount = 0;

    for (let i = 0; i < pageTexts.length; i++) {
      if (currentTokenCount + tokenCounts[i] > avgTokensPerPart && currentGroup.length > 0) {
        groups.push(currentGroup.join(''));

        // Start new group with overlap
        const overlapStart = Math.max(i - overlapPages, 0);
        currentGroup = pageTexts.slice(overlapStart, i).map((pt) => pt.text);
        currentTokenCount = tokenCounts.slice(overlapStart, i).reduce((a, b) => a + b, 0);
      }

      currentGroup.push(pageTexts[i].text);
      currentTokenCount += tokenCounts[i];
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup.join(''));
    }

    return groups;
  }

  // ===========================================================================
  // PRIVATE: TEXT ATTACHMENT & PREFIX CONVERSION
  // ===========================================================================

  private attachTextToNodes(tree: DocumentIndex, pages: PageContent[]): void {
    // O(P): Build page lookup map
    const pageMap = new Map<number, string>();
    for (const p of pages) {
      pageMap.set(p.pageNumber, p.content);
    }

    // O(N·K) where K = avg pages per node, K << P
    const traverse = (node: DocumentNode) => {
      const texts: string[] = [];
      for (let i = node.start_index; i <= node.end_index; i++) {
        const content = pageMap.get(i);
        if (content) texts.push(content);
      }
      node.text = texts.join('\n\n');
      node.nodes.forEach(traverse);
    };

    tree.structure.forEach(traverse);
  }

  /**
   * Converts parent nodes from full text to prefix-only text.
   * Prefix = pages from node.start_index to (first child start - 1).
   * Leaf nodes keep their full text unchanged.
   *
   * This reduces memory: full text can be reconstructed via getFullNodeText().
   * Should be called AFTER summary generation (which needs full text).
   */
  private convertParentsToPrefixText(tree: DocumentIndex, pages: PageContent[]): void {
    const pageMap = new Map<number, string>();
    for (const p of pages) {
      pageMap.set(p.pageNumber, p.content);
    }

    const convert = (node: DocumentNode) => {
      if (node.nodes.length > 0) {
        const firstChildStart = Math.min(...node.nodes.map((c) => c.start_index));
        if (firstChildStart > node.start_index) {
          const texts: string[] = [];
          for (let i = node.start_index; i < firstChildStart; i++) {
            const content = pageMap.get(i);
            if (content) texts.push(content);
          }
          node.text = texts.join('\n\n');
        } else {
          node.text = '';
        }
        node.nodes.forEach(convert);
      }
      // Leaf nodes keep their full text unchanged
    };

    tree.structure.forEach(convert);
  }

  // ===========================================================================
  // PRIVATE: TOKEN COUNTING FOR NODES
  // ===========================================================================

  /**
   * Computes token counts for all nodes in the tree.
   * Uses node.text directly (no double-counting).
   *
   * IMPORTANT: This should be called while parents still have full text
   * (before convertParentsToPrefixText). At that point, parent.text contains
   * all pages in its range, so estimateTokens(parent.text) correctly represents
   * the total content of the subtree.
   */
  private computeNodeTokenCounts(tree: DocumentIndex): void {
    const computeForNode = (node: DocumentNode): void => {
      // node.text contains full text (all pages from start to end)
      // which already includes children's pages — no need to add childTokens
      node.text_token_count = this.estimateTokens(node.text || '');

      // Still recurse to set children's counts
      for (const child of node.nodes) {
        computeForNode(child);
      }
    };

    for (const rootNode of tree.structure) {
      computeForNode(rootNode);
    }
  }

  // ===========================================================================
  // PRIVATE: TREE THINNING
  // ===========================================================================

  /**
   * Merges small subtrees into their parent node.
   * Since parent.text already contains full text (including children's pages),
   * thinning simply removes child nodes — no text merging needed.
   */
  private thinTree(tree: DocumentIndex): void {
    this.computeNodeTokenCounts(tree);

    const thinNodes = (nodes: DocumentNode[]): void => {
      for (const node of nodes) {
        if (
          node.text_token_count !== undefined &&
          node.text_token_count < this.config.minNodeTokens &&
          node.nodes.length > 0
        ) {
          // Parent text already includes all children's text
          node.nodes = [];
        } else if (node.nodes.length > 0) {
          // Recurse into children
          thinNodes(node.nodes);
        }
      }
    };

    thinNodes(tree.structure);
  }

  // ===========================================================================
  // PRIVATE: PER-NODE SUMMARY GENERATION (parallel, separate LLM calls)
  // ===========================================================================

  /**
   * Generates summaries for nodes using LLM.
   * @param tree - The document index
   * @param specificNodes - If provided, only generate summaries for these nodes.
   *                        Otherwise, processes all nodes in the tree.
   */
  private async generateNodeSummaries(tree: DocumentIndex, specificNodes?: DocumentNode[]): Promise<void> {
    const allNodes = specificNodes ?? this.flattenNodes(tree.structure);

    // Separate nodes that need LLM summaries from those that can use text directly
    const llmNodes: { node: DocumentNode; isLeaf: boolean }[] = [];

    for (const node of allNodes) {
      const nodeText = node.text || '';
      if (!nodeText.trim()) {
        node.summary = '';
        continue;
      }

      const tokenCount = this.estimateTokens(nodeText);
      const isLeafNode = node.nodes.length === 0;

      // Short text — use directly as summary (no LLM call needed)
      if (tokenCount < this.config.summaryTokenThreshold) {
        if (isLeafNode) {
          node.summary = nodeText.trim();
        } else {
          node.prefix_summary = nodeText.trim();
        }
        continue;
      }

      llmNodes.push({ node, isLeaf: isLeafNode });
    }

    if (llmNodes.length === 0) return;

    // Build batch inputs for all nodes that need LLM summaries
    const batchInputs = llmNodes.map(({ node, isLeaf }) => {
      const nodeText = node.text || '';
      const system = new SystemMessage(
        isLeaf
          ? `Summarize the following section content in 1-3 concise sentences. Focus on what information this section contains and what topics it covers.`
          : `Summarize the introductory/header content of this section (excluding subsections) in 1-3 concise sentences. Focus on what this section introduces or covers at a high level.`,
      );
      const human = new HumanMessage(`Section: ${node.title}\n\nContent:\n${nodeText.slice(0, 8000)}`);
      return [system, human];
    });

    // Use .batch() with maxConcurrency for parallel LLM calls
    const results = await this.structuredSummaryGenerator.batch(batchInputs, {
      maxConcurrency: 5,
    });

    // Apply results back to nodes
    for (let i = 0; i < llmNodes.length; i++) {
      const { node, isLeaf } = llmNodes[i];
      const result = results[i];

      if (result && result.summary) {
        if (isLeaf) {
          node.summary = result.summary;
        } else {
          node.prefix_summary = result.summary;
          node.summary = node.summary || result.summary;
        }
      } else {
        // Fallback: use truncated text
        const truncated = (node.text || '').slice(0, 200).trim();
        if (isLeaf) {
          node.summary = truncated;
        } else {
          node.prefix_summary = truncated;
        }
      }
    }
  }

  // ===========================================================================
  // PRIVATE: TOC VERIFICATION & FIXING
  // ===========================================================================

  private async verifyAndFixToc(tree: DocumentIndex, pages: PageContent[], documentName: string): Promise<void> {
    let attempts = 0;
    let verification = await this.verifyTocEntries(tree, pages);

    // Calculate initial accuracy using actual verified count (not assumed sample size)
    const initialAccuracy =
      verification.verifiedCount > 0 ? 1 - verification.incorrect.length / verification.verifiedCount : 1;

    console.log(
      `[PageIndexRAG] Initial ToC accuracy: ${(initialAccuracy * 100).toFixed(1)}% (${verification.incorrect.length}/${verification.verifiedCount} incorrect)`,
    );

    // If accuracy < 60%, fall back to no-ToC processing
    if (initialAccuracy < 0.6) {
      console.warn(
        `[PageIndexRAG] ToC accuracy too low (${(initialAccuracy * 100).toFixed(1)}%), regenerating structure without ToC`,
      );
      const newTree = await this.generateTreeStructure(pages, documentName);
      tree.structure = newTree.structure;
      tree.doc_name = newTree.doc_name;
      tree.doc_description = newTree.doc_description;

      // Re-attach text to new structure
      this.attachTextToNodes(tree, pages);

      // Re-thin if enabled
      if (this.config.enableTreeThinning) {
        this.thinTree(tree);
      }

      // Re-generate summaries for new structure
      if (this.config.addNodeSummary) {
        await this.generateNodeSummaries(tree);
      }

      return;
    }

    // Proceed with fixing incorrect entries
    while (verification.incorrect.length > 0 && attempts < this.config.maxTocFixAttempts) {
      console.log(
        `[PageIndexRAG] Fixing ${verification.incorrect.length} incorrect ToC entries (attempt ${attempts + 1}/${this.config.maxTocFixAttempts})`,
      );

      const nodesToFix = [...verification.incorrect];
      await this.fixIncorrectEntries(nodesToFix, pages, tree);

      // Regenerate summaries for fixed nodes (their text changed)
      if (this.config.addNodeSummary) {
        await this.generateNodeSummaries(tree, nodesToFix);
      }

      // Re-verify after fixes
      verification = await this.verifyTocEntries(tree, pages);
      attempts++;
    }

    if (verification.incorrect.length > 0) {
      console.warn(
        `[PageIndexRAG] ${verification.incorrect.length} ToC entries could not be fixed after ${attempts} attempts`,
      );
    }
  }

  private async verifyTocEntries(
    tree: DocumentIndex,
    pages: PageContent[],
  ): Promise<{ incorrect: DocumentNode[]; verifiedCount: number }> {
    const allNodes = this.flattenNodes(tree.structure);
    const leafNodes = allNodes.filter((n) => n.nodes.length === 0);

    // Sample nodes for verification — use random sampling for large docs
    const nodesToVerify = leafNodes.length > 20 ? this.randomSample(leafNodes, 20) : leafNodes;

    // we can generate keywords or big summary here here as well

    // Build batch inputs for title verification
    const validNodes: DocumentNode[] = [];
    const batchInputs: [SystemMessage, HumanMessage][] = [];

    const system = new SystemMessage(
      `Your job is to check if the given section appears or starts in the given page text.
Do fuzzy matching — ignore any space inconsistency in the page text.`,
    );

    for (const node of nodesToVerify) {
      const page = pages.find((p) => p.pageNumber === node.start_index);
      if (!page) continue;

      validNodes.push(node);
      batchInputs.push([
        system,
        new HumanMessage(`Section title: ${node.title}\n\nPage text (page ${page.pageNumber}):\n${page.content}`),
      ]);
    }

    if (batchInputs.length === 0) return { incorrect: [], verifiedCount: 0 };

    // Use .batch() with maxConcurrency for parallel verification
    const results = await this.structuredTitleVerifier.batch(batchInputs, {
      maxConcurrency: 5,
    });

    const incorrect: DocumentNode[] = [];
    for (let i = 0; i < validNodes.length; i++) {
      const result = results[i];
      if (!result || result.answer !== 'yes') {
        incorrect.push(validNodes[i]);
      }
    }

    return { incorrect, verifiedCount: validNodes.length };
  }

  private async fixIncorrectEntries(incorrectNodes: DocumentNode[], pages: PageContent[], tree: DocumentIndex): Promise<void> {
    const system = new SystemMessage(
      `You are given a section title and several pages of a document.
Find the physical page number where this section starts.
Pages are marked with <physical_index_X> tags.`,
    );

    // Build a flat ordered list of all leaf nodes so we can find the next sibling
    const allLeaves = this.flattenNodes(tree.structure).filter((n) => n.nodes.length === 0);
    const leafIndexById = new Map<string, number>();
    for (let i = 0; i < allLeaves.length; i++) {
      leafIndexById.set(allLeaves[i].node_id, i);
    }

    // Build batch inputs
    const validNodes: DocumentNode[] = [];
    const batchInputs: [SystemMessage, HumanMessage][] = [];

    for (const node of incorrectNodes) {
      const searchRange = 5;
      const startSearch = Math.max(node.start_index - searchRange, pages[0].pageNumber);
      const endSearch = Math.min(node.start_index + searchRange, pages[pages.length - 1].pageNumber);

      const searchPages = pages.filter((p) => p.pageNumber >= startSearch && p.pageNumber <= endSearch);

      const taggedContent = searchPages
        .map((p) => `<physical_index_${p.pageNumber}>\n${p.content}\n<physical_index_${p.pageNumber}>`)
        .join('\n\n');

      validNodes.push(node);
      batchInputs.push([system, new HumanMessage(`Section Title: ${node.title}\n\nDocument pages:\n${taggedContent}`)]);
    }

    if (batchInputs.length === 0) return;

    // Use .batch() with maxConcurrency for parallel fixing
    const results = await this.structuredFixEntryGenerator.batch(batchInputs, {
      maxConcurrency: 5,
    });

    const lastPage = pages[pages.length - 1].pageNumber;

    for (let i = 0; i < validNodes.length; i++) {
      const node = validNodes[i];
      const result = results[i];

      if (
        result &&
        typeof result.physical_index === 'number' &&
        result.physical_index >= pages[0].pageNumber &&
        result.physical_index <= lastPage
      ) {
        const oldStart = node.start_index;
        node.start_index = result.physical_index;

        // Recalculate end_index based on the next leaf node's start page
        const leafIdx = leafIndexById.get(node.node_id);
        if (leafIdx !== undefined && leafIdx + 1 < allLeaves.length) {
          node.end_index = Math.max(node.start_index, allLeaves[leafIdx + 1].start_index - 1);
        } else {
          node.end_index = Math.max(node.start_index, lastPage);
        }

        console.log(`[PageIndexRAG] Fixed node "${node.title}": page ${oldStart} → ${node.start_index}`);
      }
    }

    // Re-attach text for fixed nodes
    const pageMap = new Map<number, string>();
    for (const p of pages) {
      pageMap.set(p.pageNumber, p.content);
    }

    for (const node of validNodes) {
      const texts: string[] = [];
      for (let i = node.start_index; i <= node.end_index; i++) {
        const content = pageMap.get(i);
        if (content) texts.push(content);
      }
      node.text = texts.join('\n\n');
    }
  }

  // ===========================================================================
  // PRIVATE: STRIP TEXT, ASSIGN STRUCTURE INDICES
  // ===========================================================================

  private stripTextFromNodes(tree: DocumentIndex): void {
    const strip = (nodes: DocumentNode[]) => {
      for (const node of nodes) {
        delete node.text;
        delete node.text_token_count;
        strip(node.nodes);
      }
    };
    strip(tree.structure);
  }

  /**
   * Assigns auto-generated structure indices to nodes that don't already have one.
   * Uses the node's actual structure_index (not position) as prefix for children,
   * ensuring consistent hierarchical numbering.
   */
  private assignStructureIndices(nodes: DocumentNode[], prefix: string = ''): void {
    for (let i = 0; i < nodes.length; i++) {
      const idx = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      if (!nodes[i].structure_index) {
        nodes[i].structure_index = idx;
      }
      if (nodes[i].nodes.length > 0) {
        // Use the node's actual structure_index as prefix for children
        // so that children of "1.1" get "1.1.1", "1.1.2", etc.
        this.assignStructureIndices(nodes[i].nodes, nodes[i].structure_index!);
      }
    }
  }

  // ===========================================================================
  // PRIVATE: NODE MAPPING
  // ===========================================================================

  private createNodeMapping(tree: DocumentIndex): Map<string, DocumentNode> {
    const nodeMap = new Map<string, DocumentNode>();
    this.titleIndex = new Map<string, DocumentNode>();
    this.structureIndexMap = new Map<string, DocumentNode>();

    const traverse = (nodes: DocumentNode[]) => {
      for (const node of nodes) {
        nodeMap.set(node.node_id, node);

        // Index by lowercase title
        this.titleIndex.set(node.title.toLowerCase(), node);

        // Index by structure_index for cross-reference resolution
        if (node.structure_index) {
          this.structureIndexMap.set(node.structure_index, node);
        }

        // Also index common patterns like "Appendix G"
        const match = node.title.match(/^(appendix|section|chapter)\s+(\w+)/i);
        if (match) {
          this.titleIndex.set(match[0].toLowerCase(), node);
        }

        if (node.nodes?.length > 0) traverse(node.nodes);
      }
    };

    traverse(tree.structure);
    return nodeMap;
  }

  private flattenNodes(nodes: DocumentNode[]): DocumentNode[] {
    const result: DocumentNode[] = [];
    const traverse = (nodeList: DocumentNode[]) => {
      for (const node of nodeList) {
        result.push(node);
        if (node.nodes.length > 0) {
          traverse(node.nodes);
        }
      }
    };
    traverse(nodes);
    return result;
  }

  // ===========================================================================
  // PRIVATE: TREE FORMATTING FOR REASONING
  // ===========================================================================

  private formatTreeForReasoning(tree: DocumentIndex): string {
    const formatNode = (node: DocumentNode, indent: number = 0): string => {
      const prefix = '  '.repeat(indent);
      const structIdx = node.structure_index ? ` (${node.structure_index})` : '';
      let result = `${prefix}[${node.node_id}]${structIdx} ${node.title} (pages ${node.start_index}-${node.end_index})\n`;

      const summaryText = node.prefix_summary || node.summary || '';
      if (summaryText) {
        result += `${prefix}  Summary: ${summaryText}\n`;
      }

      for (const child of node.nodes) {
        result += formatNode(child, indent + 1);
      }
      return result;
    };

    let output = `Document: ${tree.doc_name}\n`;
    if (tree.doc_description) {
      output += `Description: ${tree.doc_description}\n`;
    }
    output += `Total Pages: ${tree.total_pages}\n\n`;
    output += tree.structure.map((n) => formatNode(n)).join('\n');

    return output;
  }

  // ===========================================================================
  // PRIVATE: TREE SEARCH
  // ===========================================================================

  private async performTreeSearch(query: string, excludeNodeIds: Set<string> = new Set()): Promise<TreeSearchResult> {
    const treeStructure = this.formatTreeForReasoning(this.documentIndex!);
    console.log(treeStructure);

    const excludeNote =
      excludeNodeIds.size > 0
        ? `\n\nNote: The following nodes have already been retrieved and do not need to be selected again unless they are critical: ${Array.from(excludeNodeIds).join(', ')}`
        : '';

    const system = new SystemMessage(
      `You are given a question and a document's tree structure (Table of Contents with summaries).
Your task is to identify which sections are most likely to contain the answer.

Think step-by-step:
1. Understand what information the question is asking for
2. Reason about which sections would logically contain this information based on their titles and summaries
3. Consider if multiple sections might be needed for a complete answer
4. Look for potential cross-references (e.g., "see Appendix G", "refer to Section 3.2")
5. Prefer leaf nodes (most specific sections) when possible, but include parent nodes if the question spans multiple subsections

Select the minimum number of nodes needed to answer the question comprehensively.${excludeNote}`,
    );

    const human = new HumanMessage(`Question: ${query}\n\nDocument Structure:\n${treeStructure}`);

    try {
      return await this.structuredTreeSearcher.invoke([system, human]);
    } catch (error) {
      console.error('[PageIndexRAG] Tree search failed:', error);
      // Fallback: return root-level node IDs (broad coverage)
      const rootIds = this.documentIndex!.structure.slice(0, 3).map((n) => n.node_id);
      return {
        thinking: 'Tree search failed, returning root-level nodes as fallback.',
        node_list: rootIds,
        needs_more_context: false,
        cross_references: [],
      };
    }
  }

  // ===========================================================================
  // PRIVATE: CONTENT EXTRACTION
  // ===========================================================================

  /**
   * Extracts text content from selected nodes with:
   * - Deduplication: visited set prevents the same node's text appearing twice
   *   (e.g., when both a parent and its child are selected)
   * - Token budget: stops adding nodes once maxContextTokens is reached
   * - Full text reconstruction: parent nodes' text is reconstructed from prefix + children
   */
  private extractContentFromNodes(nodeIds: string[]): string {
    const visited = new Set<string>();
    let context = '';
    let totalTokens = 0;
    const maxTokens = this.config.maxContextTokens;

    for (const nodeId of nodeIds) {
      if (visited.has(nodeId)) continue;

      const node = this.nodeMap.get(nodeId);
      if (!node) continue;

      const nodeText = this.getFullNodeText(node, visited);
      if (!nodeText.trim()) continue;

      const tokenEstimate = this.estimateTokens(nodeText);

      if (totalTokens + tokenEstimate > maxTokens) {
        console.warn(`[PageIndexRAG] Token budget reached (${totalTokens}/${maxTokens}), truncating context`);
        // Add truncated text to fill remaining budget
        const remainingChars = (maxTokens - totalTokens) * 4;
        if (remainingChars > 200) {
          context += `\n\n=== ${node.title} (Pages ${node.start_index}-${node.end_index}) [TRUNCATED] ===\n`;
          context += nodeText.slice(0, remainingChars);
          totalTokens = maxTokens;
        }
        break;
      }

      context += `\n\n=== ${node.title} (Pages ${node.start_index}-${node.end_index}) ===\n`;
      context += nodeText;
      totalTokens += tokenEstimate;
    }

    console.log(`[PageIndexRAG] Extracted context: ~${totalTokens} tokens from ${visited.size} nodes`);

    return context;
  }

  // ===========================================================================
  // PRIVATE: FIND NODE BY TITLE (FOR CROSS-REFERENCES)
  // ===========================================================================

  /**
   * Finds a node by title fragment with multi-strategy matching:
   * 1. Exact lowercase title match
   * 2. Structure index match (e.g., "3.2" or "Section 3.2")
   * 3. Substring match (title contains fragment or fragment contains title)
   */
  private findNodeByTitle(titleFragment: string): DocumentNode | null {
    const lower = titleFragment.toLowerCase().trim();

    // 1. Exact title match
    const exactMatch = this.titleIndex.get(lower);
    if (exactMatch) return exactMatch;

    // 2. Structure index match (e.g., "3.2", "section 3.2", "appendix A")
    const structMatch = lower.match(/(?:section\s+|chapter\s+)?(\d+(?:\.\d+)*|[a-z])/i);
    if (structMatch) {
      const idx = structMatch[1];
      const node = this.structureIndexMap.get(idx);
      if (node) return node;
      // Try uppercase for appendix letters
      const upperNode = this.structureIndexMap.get(idx.toUpperCase());
      if (upperNode) return upperNode;
    }

    // 3. Substring match — find a title that contains the fragment or vice versa
    for (const [title, node] of Array.from(this.titleIndex.entries())) {
      if (title.includes(lower) || lower.includes(title)) {
        return node;
      }
    }

    return null;
  }

  // ===========================================================================
  // PRIVATE: ITERATIVE TREE SEARCH
  // ===========================================================================

  private async iterativeTreeSearch(query: string, maxIterations: number = 3): Promise<string> {
    const collectedNodeIds = new Set<string>();
    let iterations = 0;

    while (iterations < maxIterations) {
      const searchResult = await this.performTreeSearch(query, collectedNodeIds);

      for (const id of searchResult.node_list) {
        if (this.nodeMap.has(id)) {
          collectedNodeIds.add(id);
        } else {
          console.warn(`[PageIndexRAG] Tree search returned non-existent node_id: "${id}", skipping`);
        }
      }

      if (searchResult.cross_references) {
        for (const ref of searchResult.cross_references) {
          const refNode = this.findNodeByTitle(ref);
          if (refNode) {
            collectedNodeIds.add(refNode.node_id);
          } else {
            console.warn(`[PageIndexRAG] Cross-reference "${ref}" could not be resolved to any node`);
          }
        }
      }

      if (!searchResult.needs_more_context) break;

      iterations++;
    }

    console.log(collectedNodeIds);

    return this.extractContentFromNodes(Array.from(collectedNodeIds));
  }

  // ===========================================================================
  // PRIVATE: ANSWER GENERATION
  // ===========================================================================

  private async generateAnswer(query: string, context: string): Promise<string> {
    const system = new SystemMessage(
      `Answer the following question based ONLY on the provided context.
If the context doesn't contain sufficient information, clearly state what's missing.
If you notice references to other sections (e.g., "see Appendix B"), mention them.
Provide a comprehensive answer with specific details from the context.`,
    );

    const human = new HumanMessage(`Question: ${query}\n\nContext:\n${context}`);

    try {
      const response = await this.llm.invoke([system, human]);
      return typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    } catch (error) {
      console.error('[PageIndexRAG] Answer generation failed:', error);
      throw new Error('Failed to generate answer from retrieved context.');
    }
  }

  private randomSample<T>(array: T[], n: number): T[] {
    if (n >= array.length) return [...array];

    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, n);
  }
}
