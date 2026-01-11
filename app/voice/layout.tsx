import React from 'react';
import type { Metadata } from 'next';
import { SidebarLayout } from '@/components/sidebar-layout';

export const metadata: Metadata = {
  title: 'Voice - Rovo AI',
  description: 'Interact with Rovo AI using natural voice conversations. Real-time voice interaction powered by VAPI.',
  keywords: 'voice assistant, AI voice, voice search, voice interaction, conversational AI, voice chat',
  openGraph: {
    title: 'Voice - Rovo AI',
    description:
      'Interact with Rovo AI using natural voice conversations. Real-time voice interaction powered by VAPI.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Voice - Rovo AI',
    description:
      'Interact with Rovo AI using natural voice conversations. Real-time voice interaction powered by VAPI.',
  },
};

interface VoiceLayoutProps {
  children: React.ReactNode;
}

export default function VoiceLayout({ children }: VoiceLayoutProps) {
  return (
    <SidebarLayout>
      <div className="min-h-screen bg-background">
        <div className="flex flex-col min-h-screen">
          <main className="flex-1" role="main" aria-label="Voice interaction">
            {children}
          </main>
        </div>
      </div>
    </SidebarLayout>
  );
}
