import { useState, useRef, useCallback, useEffect } from 'react';
import {
  SpaceBetween,
  Button,
  Textarea,
  Box,
  Spinner,
  StatusIndicator,
} from '@cloudscape-design/components';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useBillingApiClient } from '../../hooks/useBillingApiClient';

interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  content: string;
}

export default function ChatWidget() {
  const client = useBillingApiClient();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId] = useState(() => crypto.randomUUID());
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = useCallback(
    async (text?: string) => {
      const msg = (text ?? input).trim();
      if (!msg || isLoading) return;
      setMessages((p) => [...p, { role: 'user', content: msg }]);
      if (!text) setInput('');
      setIsLoading(true);
      try {
        const stream = await client.chat({ message: msg, sessionId });
        let full = '';
        try {
          for await (const chunk of stream) {
            if (chunk.chunkType === 'text' && chunk.content)
              full += chunk.content;
            else if (chunk.chunkType === 'error' && !full)
              throw new Error(chunk.content);
          }
        } catch (streamErr) {
          // If we got content before the stream broke, use it
          if (!full) throw streamErr;
        }
        setMessages((p) => [
          ...p,
          { role: 'assistant', content: full || 'No response.' },
        ]);
      } catch (err: unknown) {
        setMessages((p) => [
          ...p,
          {
            role: 'error',
            content: err instanceof Error ? err.message : 'An error occurred',
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [input, isLoading, client, sessionId],
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  return (
    <>
      {/* FAB */}
      <div
        style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 1000,
        }}
      >
        {!open && (
          <button
            onClick={() => setOpen(true)}
            aria-label="Open Billing Assistant"
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              border: 'none',
              backgroundColor: '#0972d3',
              color: '#fff',
              cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 24,
              transition: 'transform 0.2s',
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.transform = 'scale(1.1)')
            }
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          >
            💬
          </button>
        )}
      </div>

      {/* Chat panel */}
      {open && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            width: 420,
            height: 560,
            zIndex: 1001,
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#fff',
            border: '1px solid #e9ebed',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '12px 16px',
              backgroundColor: '#0972d3',
              color: '#fff',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            <Box variant="h3" color="inherit">
              <span style={{ color: '#fff' }}>Billing Assistant</span>
            </Box>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close chat"
              style={{
                background: 'none',
                border: 'none',
                color: '#fff',
                fontSize: 20,
                cursor: 'pointer',
                padding: '0 4px',
              }}
            >
              ✕
            </button>
          </div>

          {/* Messages */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 12,
            }}
          >
            {messages.length === 0 ? (
              <Box padding="l" textAlign="center" color="text-body-secondary">
                Ask about costs, billing groups, pricing, or optimization.
              </Box>
            ) : (
              <SpaceBetween size="s">
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      justifyContent:
                        msg.role === 'user' ? 'flex-end' : 'flex-start',
                    }}
                  >
                    {msg.role === 'user' ? (
                      <div
                        style={{
                          maxWidth: '80%',
                          padding: '8px 12px',
                          borderRadius: '12px 12px 2px 12px',
                          backgroundColor: '#0972d3',
                          color: '#fff',
                          fontSize: 13,
                          lineHeight: 1.5,
                        }}
                      >
                        {msg.content}
                      </div>
                    ) : msg.role === 'error' ? (
                      <StatusIndicator type="error">
                        {msg.content}
                      </StatusIndicator>
                    ) : (
                      <div
                        style={{
                          maxWidth: '90%',
                          padding: '8px 12px',
                          borderRadius: '12px 12px 12px 2px',
                          backgroundColor: '#f2f3f3',
                          fontSize: 13,
                          lineHeight: 1.6,
                        }}
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                ))}
                {isLoading && (
                  <SpaceBetween size="xs" direction="horizontal">
                    <Spinner size="normal" />
                    <Box fontSize="body-s" color="text-body-secondary">
                      Analyzing...
                    </Box>
                  </SpaceBetween>
                )}
              </SpaceBetween>
            )}
            <div ref={endRef} />
          </div>

          {/* Input */}
          <div
            style={{
              borderTop: '1px solid #e9ebed',
              padding: 12,
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <Textarea
                  value={input}
                  onChange={({ detail }) => setInput(detail.value)}
                  onKeyDown={handleKey as any}
                  placeholder="Ask me anything — costs, billing groups, pricing, credits..."
                  rows={1}
                  disabled={isLoading}
                />
              </div>
              <Button
                variant="primary"
                onClick={() => send()}
                loading={isLoading}
                disabled={!input.trim()}
                iconName="send"
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
