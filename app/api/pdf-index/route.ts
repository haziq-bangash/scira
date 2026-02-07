import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { after } from 'next/server';

import { getLightweightUser } from '@/app/actions';
import {
  saveChat,
  getChatById,
  saveDocumentIndex,
  getDocumentIndicesByChatId,
  getDocumentIndexByFileUrl,
} from '@/lib/db/queries';
import { processAndIndexPdf } from '@/lib/pdf-processing';

const PostBodySchema = z.object({
  chatId: z.string().min(1),
  fileUrl: z.url(),
  fileName: z.string().min(1),
});

export async function POST(req: NextRequest) {
  // Auth check — pro only
  const lightweightUser = await getLightweightUser();
  if (!lightweightUser) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  if (!lightweightUser.isProUser) {
    return NextResponse.json({ error: 'Pro subscription required for PDF indexing' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = PostBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', details: parsed.error.flatten() }, { status: 400 });
  }

  const { chatId, fileUrl, fileName } = parsed.data;

  // Check if this file is already indexed (avoid duplicates)
  const existing = await getDocumentIndexByFileUrl(fileUrl);
  if (existing) {
    return NextResponse.json({
      id: existing.id,
      status: existing.status,
      message: 'Document already being processed or indexed',
    });
  }

  // Ensure the chat row exists (it may not if this is a new chat and the first message hasn't been sent yet)
  const existingChat = await getChatById({ id: chatId });
  if (!existingChat) {
    await saveChat({
      id: chatId,
      userId: lightweightUser.userId,
      title: 'New Chat',
      visibility: 'private',
    });
  }

  // Create the document_index row with status: pending
  const record = await saveDocumentIndex({
    chatId,
    userId: lightweightUser.userId,
    fileName,
    fileUrl,
  });

  // Kick off background processing using next/server after()
  after(async () => {
    await processAndIndexPdf({
      documentIndexId: record.id,
      fileUrl,
      fileName,
    });
  });

  return NextResponse.json({
    id: record.id,
    status: 'pending',
    message: 'PDF indexing started in background',
  });
}

export async function GET(req: NextRequest) {
  const lightweightUser = await getLightweightUser();
  if (!lightweightUser) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get('chatId');

  if (!chatId) {
    return NextResponse.json({ error: 'chatId query parameter is required' }, { status: 400 });
  }

  const indices = await getDocumentIndicesByChatId(chatId);

  // Only return metadata, not the full tree/page contents (too large)
  const results = indices.map((idx) => ({
    id: idx.id,
    fileName: idx.fileName,
    fileUrl: idx.fileUrl,
    status: idx.status,
    totalPages: idx.totalPages,
    error: idx.error,
    createdAt: idx.createdAt,
  }));

  return NextResponse.json({ indices: results });
}
