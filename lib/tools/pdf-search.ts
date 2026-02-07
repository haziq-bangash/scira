import { tool } from 'ai';
import { z } from 'zod';
import { PageIndexRAG, type PageContent, type DocumentIndex } from '@/lib/page-index-rag';
import { getReadyDocumentIndicesByChatId } from '@/lib/db/queries';

export function createPdfSearchTool(chatId: string) {
  return tool({
    description:
      'Search through PDF documents uploaded in this conversation. Use when the user asks questions about uploaded PDF files or documents. Returns relevant sections from the PDFs.',
    inputSchema: z.object({
      query: z.string().describe('The search query to find relevant information in the uploaded PDFs'),
    }),
    execute: async ({ query }) => {
      const indices = await getReadyDocumentIndicesByChatId(chatId);

      if (indices.length === 0) {
        return { results: [] as { fileName: string; context: string; fileUrl: string }[], totalDocuments: 0, message: 'No indexed PDF documents found in this chat.' };
      }

      const results: { fileName: string; context: string; fileUrl: string }[] = [];

      for (const docIndex of indices) {
        if (!docIndex.treeIndex) continue;

        const rag = new PageIndexRAG();

        // Load tree and re-attach page text if available
        if (docIndex.pageContents) {
          rag.loadIndexWithPages(
            docIndex.treeIndex as DocumentIndex,
            docIndex.pageContents as PageContent[],
          );
        } else {
          rag.loadIndex(docIndex.treeIndex as DocumentIndex);
        }

        try {
          const context = await rag.retrieveContext(query);
          if (context.trim()) {
            results.push({
              fileName: docIndex.fileName,
              context,
              fileUrl: docIndex.fileUrl,
            });
          }
        } catch (err) {
          console.error(`[pdf_search] Failed to search ${docIndex.fileName}:`, err);
        } finally {
          rag.dispose();
        }
      }

      return {
        results,
        totalDocuments: indices.length,
        message:
          results.length > 0
            ? `Found relevant content in ${results.length} document(s).`
            : 'No relevant content found in the uploaded documents.',
      };
    },
  });
}
