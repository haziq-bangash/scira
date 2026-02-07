import 'server-only';

import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { PageIndexRAG, type PageContent } from './page-index-rag';
import { updateDocumentIndex } from './db/queries';

/**
 * Downloads a PDF from the given URL, extracts per-page text using LangChain's PDFLoader,
 * indexes it with PageIndexRAG, and persists the tree + page contents to the database.
 */
export async function processAndIndexPdf(params: {
  documentIndexId: string;
  fileUrl: string;
  fileName: string;
}): Promise<void> {
  const { documentIndexId, fileUrl, fileName } = params;

  try {
    await updateDocumentIndex({ id: documentIndexId, status: 'processing' });

    console.log(`[PDF Processing] Downloading ${fileName} from ${fileUrl}`);

    // 1. Download PDF from Vercel Blob
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();

    console.log(`[PDF Processing] Extracting text from ${fileName} (${(blob.size / 1024).toFixed(1)}KB)`);

    // 2. Extract pages using LangChain PDFLoader
    const loader = new PDFLoader(blob, { splitPages: true });
    const docs = await loader.load();

    if (docs.length === 0) {
      throw new Error('PDF contains no extractable text');
    }

    // 3. Convert to PageContent[] format
    const pages: PageContent[] = docs.map((doc, i) => ({
      pageNumber: (doc.metadata?.loc?.pageNumber ?? i + 1) as number,
      content: doc.pageContent,
    }));

    console.log(`[PDF Processing] Extracted ${pages.length} pages from ${fileName}, starting indexing`);

    // 4. Run PageIndexRAG indexing
    const rag = new PageIndexRAG();
    const tree = await rag.indexDocument(pages, fileName);
    rag.dispose();

    console.log(`[PDF Processing] Indexing complete for ${fileName}: ${tree.structure.length} top-level nodes`);

    // 5. Save to DB
    await updateDocumentIndex({
      id: documentIndexId,
      status: 'ready',
      treeIndex: tree,
      pageContents: pages,
      totalPages: pages.length,
    });

    console.log(`[PDF Processing] Successfully indexed ${fileName}`);
  } catch (error) {
    console.error(`[PDF Processing] Failed to index ${fileName}:`, error);
    await updateDocumentIndex({
      id: documentIndexId,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error during PDF indexing',
    });
  }
}
