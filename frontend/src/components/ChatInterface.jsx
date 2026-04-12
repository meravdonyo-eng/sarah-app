import { useState, useRef, useEffect } from 'react';
import { apiUrl } from '../config';

function ChatInterface() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [useTools, setUseTools] = useState(true);
  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Listen for OAuth completion
  useEffect(() => {
    const handleMessage = (event) => {
      if (event.data?.type === 'oauth_complete') {
        setMessages((prev) => [
          ...prev,
          {
            role: 'system',
            content: `Connected to ${event.data.server}! You can now ask questions about your data.`,
          },
        ]);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleOAuthClick = (authUrl) => {
    window.open(authUrl, 'oauth', 'width=600,height=700');
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setLoading(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const res = await fetch(apiUrl('/api/chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        signal: abortController.signal,
        body: JSON.stringify({
          message: userMessage,
          useTools,
          conversationHistory,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Failed to get response');
      }

      const data = await res.json();

      // Update conversation history if using tools
      if (data.conversationHistory) {
        setConversationHistory(data.conversationHistory);
      }

      // Handle OAuth actions
      if (data.oauthActions && data.oauthActions.length > 0) {
        for (const action of data.oauthActions) {
          if (action.type === 'oauth') {
            setMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                content: data.response,
                oauthUrl: action.authUrl,
              },
            ]);
            return;
          }
        }
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: data.response }]);
    } catch (err) {
      if (err.name === 'AbortError') {
        setMessages((prev) => [
          ...prev,
          { role: 'system', content: 'Request cancelled.' },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: 'error', content: err.message || 'Something went wrong' },
        ]);
      }
    } finally {
      abortControllerRef.current = null;
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="flex flex-col h-[600px] bg-white rounded-lg shadow-sm border border-gray-200">
      {/* Messages container */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 mt-8">
            <p>Start a conversation with Claude</p>
          </div>
        )}
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] px-4 py-3 rounded-2xl ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white rounded-br-md'
                  : msg.role === 'error'
                  ? 'bg-red-100 text-red-700 rounded-bl-md'
                  : msg.role === 'system'
                  ? 'bg-green-50 text-green-700 rounded-bl-md border border-green-200'
                  : 'bg-gray-100 text-gray-800 rounded-bl-md'
              }`}
            >
              <p className="whitespace-pre-wrap">{msg.content}</p>
              {msg.oauthUrl && (
                <button
                  onClick={() => handleOAuthClick(msg.oauthUrl)}
                  className="mt-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
                >
                  Connect to Mixpanel
                </button>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-800 px-4 py-3 rounded-2xl rounded-bl-md">
              <div className="flex space-x-2">
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input form */}
      <div className="p-4 border-t border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={useTools}
              onChange={(e) => setUseTools(e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
            />
            Enable integrations
          </label>
          {messages.length > 0 && (
            <button
              onClick={() => {
                setMessages([]);
                setConversationHistory([]);
              }}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Clear chat
            </button>
          )}
        </div>
        <form onSubmit={handleSubmit}>
          <div className="flex space-x-3">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              rows={1}
              className="flex-1 px-4 py-3 border border-gray-300 rounded-full focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              disabled={loading}
            />
            {loading ? (
              <button
                type="button"
                onClick={handleCancel}
                className="px-6 py-3 bg-red-500 text-white rounded-full font-medium hover:bg-red-600 transition-colors"
              >
                Cancel
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="px-6 py-3 bg-blue-600 text-white rounded-full font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                Send
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

export default ChatInterface;
