import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ContentLayout,
  Header,
  Container,
  SpaceBetween,
  Button,
  Textarea,
  Box,
  Spinner,
  StatusIndicator,
  Icon,
  Cards,
} from '@cloudscape-design/components';
import { createFileRoute } from '@tanstack/react-router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useBillingApiClient } from '../hooks/useBillingApiClient';

export const Route = createFileRoute('/chat')({
  component: ChatPage,
});

interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  content: string;
  timestamp: Date;
}

const SUGGESTIONS = [
  {
    title: '💰 Costs & Spend',
    description:
      'What is my current month spend and how does it compare to last month?',
  },
  {
    title: '📋 Billing Groups',
    description:
      'Show me all billing groups with their margins and pro forma costs',
  },
  {
    title: '🔄 Transfer Billing',
    description:
      'Explain how showback pricing works and what gaps exist in pro forma data',
  },
  {
    title: '📊 Pricing & Credits',
    description:
      'What pricing plans and custom line items are configured for my customers?',
  },
];

const markdownComponents = {
  table: ({ children, ...props }: any) => (
    <div style={{ overflowX: 'auto', margin: '12px 0' }}>
      <table
        {...props}
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: '13px',
          border: '1px solid #e9ebed',
        }}
      >
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }: any) => (
    <thead
      {...props}
      style={{ backgroundColor: '#fafafa', borderBottom: '2px solid #e9ebed' }}
    >
      {children}
    </thead>
  ),
  th: ({ children, ...props }: any) => (
    <th
      {...props}
      style={{
        padding: '8px 12px',
        textAlign: 'left',
        fontWeight: 700,
        color: '#0f1b2a',
        borderBottom: '2px solid #e9ebed',
      }}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }: any) => (
    <td
      {...props}
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid #e9ebed',
        color: '#414d5c',
      }}
    >
      {children}
    </td>
  ),
  h1: ({ children, ...props }: any) => (
    <h2
      {...props}
      style={{
        fontSize: '20px',
        fontWeight: 700,
        margin: '16px 0 8px',
        color: '#0f1b2a',
      }}
    >
      {children}
    </h2>
  ),
  h2: ({ children, ...props }: any) => (
    <h3
      {...props}
      style={{
        fontSize: '17px',
        fontWeight: 700,
        margin: '14px 0 6px',
        color: '#0f1b2a',
      }}
    >
      {children}
    </h3>
  ),
  h3: ({ children, ...props }: any) => (
    <h4
      {...props}
      style={{
        fontSize: '15px',
        fontWeight: 700,
        margin: '12px 0 4px',
        color: '#0f1b2a',
      }}
    >
      {children}
    </h4>
  ),
  ul: ({ children, ...props }: any) => (
    <ul {...props} style={{ margin: '6px 0', paddingLeft: '20px' }}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: any) => (
    <ol {...props} style={{ margin: '6px 0', paddingLeft: '20px' }}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }: any) => (
    <li {...props} style={{ margin: '3px 0', lineHeight: '1.5' }}>
      {children}
    </li>
  ),
  code: ({ children, className, ...props }: any) => {
    const isInline = !className;
    return isInline ? (
      <code
        {...props}
        style={{
          backgroundColor: '#f2f3f3',
          padding: '2px 6px',
          borderRadius: '4px',
          fontSize: '12px',
          fontFamily: 'monospace',
        }}
      >
        {children}
      </code>
    ) : (
      <pre
        style={{
          backgroundColor: '#0f1b2a',
          color: '#d1d5db',
          padding: '12px 16px',
          borderRadius: '8px',
          overflow: 'auto',
          fontSize: '12px',
          margin: '8px 0',
        }}
      >
        <code {...props}>{children}</code>
      </pre>
    );
  },
  p: ({ children, ...props }: any) => (
    <p {...props} style={{ margin: '6px 0', lineHeight: '1.6' }}>
      {children}
    </p>
  ),
  strong: ({ children, ...props }: any) => (
    <strong {...props} style={{ fontWeight: 700, color: '#0f1b2a' }}>
      {children}
    </strong>
  ),
  hr: (props: any) => (
    <hr
      {...props}
      style={{
        border: 'none',
        borderTop: '1px solid #e9ebed',
        margin: '12px 0',
      }}
    />
  ),
};

function ChatPage() {
  const client = useBillingApiClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId] = useState(() => crypto.randomUUID());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(scrollToBottom, [messages, scrollToBottom]);

  const sendMessage = useCallback(
    async (text?: string) => {
      const trimmed = (text ?? input).trim();
      if (!trimmed || isLoading) return;

      setMessages((prev) => [
        ...prev,
        { role: 'user', content: trimmed, timestamp: new Date() },
      ]);
      if (!text) setInput('');
      setIsLoading(true);

      try {
        const stream = await client.chat({ message: trimmed, sessionId });
        let fullText = '';
        try {
          for await (const chunk of stream) {
            if (chunk.chunkType === 'text' && chunk.content) {
              fullText += chunk.content;
            } else if (chunk.chunkType === 'error') {
              if (!fullText) throw new Error(chunk.content);
            }
          }
        } catch (streamErr) {
          if (!fullText) throw streamErr;
        }
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: fullText || 'No response received.',
            timestamp: new Date(),
          },
        ]);
      } catch (err: unknown) {
        setMessages((prev) => [
          ...prev,
          {
            role: 'error',
            content: err instanceof Error ? err.message : 'An error occurred',
            timestamp: new Date(),
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [input, isLoading, client, sessionId],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage],
  );

  return (
    <ContentLayout
      header={
        <Header description="AI-powered insights into your AWS billing, costs, and optimization opportunities">
          Billing Assistant
        </Header>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: 'calc(100vh - 200px)',
        }}
      >
        {/* Messages area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 16px' }}>
          {messages.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: '24px',
              }}
            >
              <SpaceBetween size="s" alignItems="center">
                <Icon name="contact" size="big" variant="subtle" />
                <Box variant="h2" textAlign="center">
                  How can I help with your billing?
                </Box>
                <Box color="text-body-secondary" textAlign="center">
                  I can query your real billing data — costs, billing groups,
                  margins, pricing plans, credits, billing transfer details, and
                  more.
                </Box>
              </SpaceBetween>
              <div style={{ width: '100%', maxWidth: '800px' }}>
                <Cards
                  items={SUGGESTIONS}
                  cardDefinition={{
                    header: (item) => (
                      <span style={{ cursor: 'pointer' }}>{item.title}</span>
                    ),
                    sections: [
                      {
                        content: (item) => (
                          <Box color="text-body-secondary" fontSize="body-s">
                            {item.description}
                          </Box>
                        ),
                      },
                    ],
                  }}
                  onSelectionChange={({ detail }) => {
                    const selected = detail.selectedItems[0];
                    if (selected) sendMessage(selected.description);
                  }}
                  selectionType="single"
                  cardsPerRow={[{ cards: 1 }, { minWidth: 400, cards: 2 }]}
                />
              </div>
            </div>
          ) : (
            <SpaceBetween size="m">
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
                        maxWidth: '70%',
                        padding: '10px 16px',
                        borderRadius: '16px 16px 4px 16px',
                        backgroundColor: '#0972d3',
                        color: '#fff',
                        fontSize: '14px',
                        lineHeight: '1.5',
                      }}
                    >
                      {msg.content}
                    </div>
                  ) : msg.role === 'error' ? (
                    <Container>
                      <StatusIndicator type="error">
                        {msg.content}
                      </StatusIndicator>
                    </Container>
                  ) : (
                    <div style={{ maxWidth: '90%', width: '100%' }}>
                      <Container>
                        <div
                          style={{
                            fontSize: '14px',
                            lineHeight: '1.6',
                            color: '#0f1b2a',
                          }}
                        >
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={markdownComponents}
                          >
                            {msg.content}
                          </ReactMarkdown>
                        </div>
                        <Box
                          float="right"
                          fontSize="body-s"
                          color="text-body-secondary"
                          padding={{ top: 'xs' }}
                        >
                          {msg.timestamp.toLocaleTimeString()}
                        </Box>
                      </Container>
                    </div>
                  )}
                </div>
              ))}

              {isLoading && (
                <Container>
                  <SpaceBetween size="xs" direction="horizontal">
                    <Spinner size="normal" />
                    <StatusIndicator type="loading">
                      Analyzing your billing data...
                    </StatusIndicator>
                  </SpaceBetween>
                </Container>
              )}
            </SpaceBetween>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div
          style={{
            borderTop: '1px solid #e9ebed',
            paddingTop: '16px',
            backgroundColor: '#fff',
          }}
        >
          <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <Textarea
                value={input}
                onChange={({ detail }) => setInput(detail.value)}
                onKeyDown={handleKeyDown as any}
                placeholder="Ask me anything — costs, billing groups, pricing plans, credits, billing transfer, margins..."
                rows={2}
                disabled={isLoading}
              />
            </div>
            <Button
              variant="primary"
              onClick={() => sendMessage()}
              loading={isLoading}
              disabled={!input.trim()}
              iconName="send"
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    </ContentLayout>
  );
}
