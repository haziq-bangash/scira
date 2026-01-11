"use client";

import { getAssistant } from "@/lib/assistant";

import {
  Message,
  MessageTypeEnum,
  TranscriptMessage,
  TranscriptMessageTypeEnum,
} from "@/lib/types";

import { useEffect, useState } from "react";
// import { MessageActionTypeEnum, useMessages } from "./useMessages";
import { vapi } from "@/lib/vapi.sdk";

export enum CALL_STATUS {
  INACTIVE = "inactive",
  ACTIVE = "active",
  LOADING = "loading",
}

interface ConversationTurn {
  role: "user" | "assistant" | "tool";
  text: string;
  name?: string;
  args?: string;
  callId?: string;
  kind?: "call" | "output";
}

export type AgentState = null | "thinking" | "listening" | "talking";

interface VoiceStats {
  lastLatencyMs: number | null;
  lastAssistantWpm: number | null;
  lastUserWpm: number | null;
  lastToolLatencyMs: number | null;
}

export function useVapi({assistantOverides = null}: {assistantOverides: any}) {
  const [isSpeechActive, setIsSpeechActive] = useState(false);
  const [callStatus, setCallStatus] = useState<CALL_STATUS>(
    CALL_STATUS.INACTIVE
  );

  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);

  const [activeTranscript, setActiveTranscript] =
    useState<TranscriptMessage | null>(null);

  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<AgentState>(null);
  const [stats, setStats] = useState<VoiceStats>({
    lastLatencyMs: null,
    lastAssistantWpm: null,
    lastUserWpm: null,
    lastToolLatencyMs: null,
  });

  useEffect(() => {
    const onSpeechStart = () => {
      setIsSpeechActive(true);
      setAgentState("talking");
    };
    const onSpeechEnd = () => {
      setIsSpeechActive(false);
      setAgentState("listening");
    };

    const onCallStartHandler = () => {
      setCallStatus(CALL_STATUS.ACTIVE);
      setAgentState("listening");
      setError(null);
    };

    const onCallEnd = () => {
      setCallStatus(CALL_STATUS.INACTIVE);
      setConversation([]);
      setAgentState(null);
    };

    const onVolumeLevel = (volume: number) => {
      setAudioLevel(volume);
    };

    const onMessageUpdate = async (message: any) => {
      // Handle tool calls (Vapi sends this as a custom type, not in MessageTypeEnum)
      if (message.type === 'tool-calls') {
        const toolCalls = message.toolCallList || [];
        for (const toolCall of toolCalls) {
          const functionName = toolCall.function?.name;
          const callId = toolCall.id;
          
          let parameters: Record<string, unknown> = {};
          try {
            const args = toolCall.function?.arguments;
            if (typeof args === 'string') {
              parameters = JSON.parse(args || '{}');
            } else if (typeof args === 'object' && args !== null) {
              parameters = args as Record<string, unknown>;
            }
          } catch (err) {
            console.error('[Vapi] Failed to parse tool arguments:', err);
            continue;
          }

          console.log(`[Vapi] Tool called: ${functionName}`, parameters);

          // Add tool call to conversation
          setConversation((prev) => [
            ...prev,
            {
              role: "tool",
              kind: "call",
              name: functionName,
              callId,
              args: JSON.stringify(parameters),
              text: "",
            },
          ]);

          // Execute tool by calling API
          try {
            const response = await fetch('/api/search-tool', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                toolName: functionName,
                parameters,
              }),
            });

            const data = await response.json();

            if (data.success) {
              const resultText = typeof data.result === 'string' 
                ? data.result 
                : JSON.stringify(data.result);

              // Add tool result to conversation
              setConversation((prev) => [
                ...prev,
                {
                  role: "tool",
                  kind: "output",
                  name: functionName,
                  callId,
                  text: resultText,
                },
              ]);

              // Send results back to Vapi as context
              vapi.send({
                type: 'add-message',
                message: {
                  role: 'system',
                  content: `Tool ${functionName} returned: ${resultText}`,
                },
              });
            } else {
              console.error(`[Vapi] Tool execution failed:`, data.error);
            }
          } catch (error) {
            console.error(`[Vapi] Error executing tool:`, error);
          }
        }
      }

      // Handle regular messages
      if (
        message.type === MessageTypeEnum.TRANSCRIPT &&
        message.transcriptType === TranscriptMessageTypeEnum.PARTIAL
      ) {
        setActiveTranscript(message);
      } else if (
        message.type === MessageTypeEnum.TRANSCRIPT &&
        message.transcriptType === TranscriptMessageTypeEnum.FINAL
      ) {
        setMessages((prev) => [...prev, message]);
        setActiveTranscript(null);
        
        // Add to conversation
        const role = message.role === 'user' ? 'user' : 'assistant';
        const text = message.transcript || '';
        if (text.trim()) {
          setConversation((prev) => [
            ...prev,
            { role, text }
          ]);
        }
      } else {
        setMessages((prev) => [...prev, message]);
        setActiveTranscript(null);
      }
    };

    const onError = (e: any) => {
      setCallStatus(CALL_STATUS.INACTIVE);
      setAgentState(null);
      
      // Handle various error formats
      let errorMessage = 'An error occurred';
      if (typeof e === 'string') {
        errorMessage = e;
      } else if (e?.message) {
        errorMessage = e.message;
      } else if (e?.error?.message) {
        errorMessage = e.error.message;
      } else if (e?.msg) {
        errorMessage = e.msg;
      } else if (e?.details) {
        errorMessage = typeof e.details === 'string' ? e.details : JSON.stringify(e.details);
      }
      
      setError(errorMessage);
      console.error('[Vapi] Error:', e, 'Parsed message:', errorMessage);
    };

    vapi.on("speech-start", onSpeechStart);
    vapi.on("speech-end", onSpeechEnd);
    vapi.on("call-start", onCallStartHandler);
    vapi.on("call-end", onCallEnd);
    vapi.on("volume-level", onVolumeLevel);
    vapi.on("message", onMessageUpdate);
    vapi.on("error", onError);

    return () => {
      vapi.off("speech-start", onSpeechStart);
      vapi.off("speech-end", onSpeechEnd);
      vapi.off("call-start", onCallStartHandler);
      vapi.off("call-end", onCallEnd);
      vapi.off("volume-level", onVolumeLevel);
      vapi.off("message", onMessageUpdate);
      vapi.off("error", onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    setCallStatus(CALL_STATUS.LOADING);
    setError(null);
    console.log('[Vapi] Starting call with overrides:', assistantOverides);
    try {
      const makeAssistant = await getAssistant(assistantOverides);
      const response = vapi.start(makeAssistant);
      
      response.then((res) => {
        console.log("[Vapi] Call started successfully:", res);
      }).catch((error) => {
        console.error("[Vapi] Failed to start call:", error);
        setCallStatus(CALL_STATUS.INACTIVE);
        setError(error?.message || "Failed to start call");
      });
    } catch (error: any) {
      console.error("[Vapi] Error preparing assistant:", error);
      setCallStatus(CALL_STATUS.INACTIVE);
      setError(error?.message || "Failed to prepare assistant");
    }
  };

  const stop = () => {
    setCallStatus(CALL_STATUS.LOADING);
    vapi.stop();
  };

  const toggleCall = () => {
    if (callStatus == CALL_STATUS.ACTIVE) {
      stop();
    } else {
      start();
    }
  };

  const sendText = (text: string) => {
    if (!text.trim()) return;
    vapi.send({
      type: 'add-message',
      message: {
        role: 'user',
        content: text,
      },
    });
    // Add to conversation immediately
    setConversation((prev) => [
      ...prev,
      { role: 'user', text }
    ]);
  };

  const isConnected = callStatus === CALL_STATUS.ACTIVE;

  return {
    isSpeechActive,
    callStatus,
    audioLevel,
    activeTranscript,
    messages,
    conversation,
    start,
    stop,
    toggleCall,
    error,
    agentState,
    stats,
    isConnected,
    sendText,
  };
}
