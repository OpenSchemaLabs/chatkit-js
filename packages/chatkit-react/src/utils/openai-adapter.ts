import type { CustomApiConfig, OpenAIApiConfig } from '@openai/chatkit';

/**
 * Creates a CustomApiConfig that adapts ChatKit API requests to OpenAI API.
 */
export function createOpenAIAdapter(config: OpenAIApiConfig): CustomApiConfig {
  const {
    apiKey,
    endpoint = 'https://api.openai.com/v1/chat/completions',
    model = 'gpt-3.5-turbo',
    dangerouslyAllowBrowserKey,
  } = config;

  if (!dangerouslyAllowBrowserKey && !apiKey.startsWith('http')) {
    console.warn(
      'Using an OpenAI API key in the browser is not recommended for production applications.',
    );
  }

  const domainKey = 'openai-adapter-domain-key';
  const url = 'https://openai-adapter.local/api/chatkit';

  return {
    url,
    domainKey,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = input.toString();

      // Intercept requests to our dummy URL
      if (requestUrl.startsWith(url)) {
        if (init?.method === 'POST') {
          try {
            const body = init.body ? JSON.parse(init.body as string) : {};
            const openAIMessages = [];

            if (Array.isArray(body.messages)) {
              openAIMessages.push(...body.messages.map((m: any) => ({
                role: m.role || (m.isUser ? 'user' : 'assistant'),
                content: m.content || m.text,
              })));
            } else if (body.text) {
               openAIMessages.push({ role: 'user', content: body.text });
            }

            const openAIResponse = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model,
                messages: openAIMessages,
                stream: true,
              }),
            });

            if (!openAIResponse.ok) {
              const errorText = await openAIResponse.text();
              throw new Error(`OpenAI API Error: ${openAIResponse.status} ${errorText}`);
            }

            // Transform OpenAI SSE stream to a format ChatKit can understand.
            // Note: Since the exact ChatKit SSE protocol is not documented here,
            // we assume a 'message.delta' event structure similar to typical chat apps.
            // If the UI doesn't render, this transformer needs to be adjusted to match
            // the specific event names (e.g., 'chunk', 'text', etc.) expected by the Web Component.

            const transformer = new TransformStream({
                async transform(chunk, controller) {
                    const text = new TextDecoder().decode(chunk);
                    const lines = text.split('\n');
                    for (const line of lines) {
                        if (line.trim() === '') continue;
                        if (line.trim() === 'data: [DONE]') continue;
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.slice(6));
                                const content = data.choices?.[0]?.delta?.content;
                                if (content) {
                                    // Construct ChatKit SSE event
                                    // Assuming 'message.delta' event with 'text' or 'content' field
                                    const eventData = JSON.stringify({
                                        text: content,
                                        content: content,
                                        type: 'text'
                                    });
                                    // SSE Format:
                                    // event: message.delta\n
                                    // data: { ... }\n\n
                                    const sseMessage = `event: message.delta\ndata: ${eventData}\n\n`;
                                    controller.enqueue(new TextEncoder().encode(sseMessage));
                                }
                            } catch (e) {
                                // Ignore parse errors for partial chunks
                            }
                        }
                    }
                }
            });

            return new Response(openAIResponse.body?.pipeThrough(transformer), {
                headers: { 'Content-Type': 'text/event-stream' }
            });

          } catch (e) {
            console.error('[OpenAI Adapter] Error:', e);
            return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
          }
        }
      }

      return fetch(input, init);
    },
  };
}
