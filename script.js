document.addEventListener("DOMContentLoaded", function () {
    const chatInput = document.getElementById('chatInput');
    const sendChatBtn = document.getElementById('sendChat');
    const chatbotMessages = document.getElementById('chatbotMessages');
    const chatbotWidget = document.getElementById('chatbotWidget');
    const chatToggle = document.getElementById('chatToggle');
    const closeChat = document.getElementById('closeChat');

    // Toggle Chat Visibility
    if (chatToggle && closeChat && chatbotWidget) {
        chatToggle.addEventListener('click', () => {
            chatbotWidget.classList.remove('hidden');
            chatToggle.style.visibility = 'hidden';
            chatToggle.style.opacity = '0';
        });

        closeChat.addEventListener('click', () => {
            chatbotWidget.classList.add('hidden');
            chatToggle.style.visibility = 'visible';
            chatToggle.style.opacity = '1';
        });
    }

    // 1. Session Management (Ephemeral for Guests)
    const SESSION_KEY = 'teckeySessionId';
    let sessionId = sessionStorage.getItem(SESSION_KEY);
    if (!sessionId) {
        sessionId = 'session_' + Math.random().toString(36).substring(2, 15);
        sessionStorage.setItem(SESSION_KEY, sessionId);
    }

    // Function to add a message to the UI
    function appendMessage(text, sender) {
        const msgDiv = document.createElement('div');
        msgDiv.classList.add('message');
        msgDiv.classList.add(sender === 'user' ? 'user-message' : 'bot-message');
        msgDiv.textContent = text;
        chatbotMessages.appendChild(msgDiv);
        chatbotMessages.scrollTop = chatbotMessages.scrollHeight;
    }

    // Load history from MongoDB Backend (in background)
    async function loadHistory() {
        try {
            // Uncomment the lines below to load visual history on refresh if desired in the future:
            /*
            const response = await fetch(`/api/history/${sessionId}`);
            if (response.ok) {
                const history = await response.json();
                // Render it if needed...
            }
            */
            // We don't render it here based on your previous request to have a "clean starting page"
            console.log('Session initialized:', sessionId);
        } catch (err) {
            console.error('Failed to load history from backend', err);
        }
    }

    // Call loadHistory on startup
    loadHistory();

    async function fetchLlama3Response(userMessage) {
        // 1. Handle Admin Login Command
        if (userMessage.startsWith('/admin ')) {
            const key = userMessage.replace('/admin ', '').trim();
            localStorage.setItem('teckeyAdminKey', key);
            return "Admin key saved locally. You can now use /feed commands.";
        }

        // 1.5 Handle Admin Logout Command
        if (userMessage.toLowerCase() === '/logout') {
            localStorage.removeItem('teckeyAdminKey');
            return "Logged out from Admin mode. Conversations will no longer be saved.";
        }

        // 2. Handle Knowledge Feeding Command
        if (userMessage.startsWith('/feed ')) {
            const adminKey = localStorage.getItem('teckeyAdminKey');
            const parts = userMessage.replace('/feed ', '').split('|');
            if (parts.length < 2) return "Format error. Use: /feed Topic | Content";

            try {
                const response = await fetch('/api/admin/feed', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        adminKey,
                        topic: parts[0].trim(),
                        content: parts[1].trim()
                    })
                });
                const resData = await response.json();
                return resData.message || resData.error;
            } catch (err) {
                return "Failed to connect to admin API.";
            }
        }

        // 3. Regular Chat
        try {
            const adminKey = localStorage.getItem('teckeyAdminKey');
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: sessionId,
                    message: userMessage,
                    adminKey: adminKey // Send key if we have it
                })
            });

            if (!response.ok) {
                throw new Error(`Backend Error: ${response.status}`);
            }

            const data = await response.json();
            return data.reply;
        } catch (error) {
            console.error('Error fetching from backend:', error);
            return "I'm sorry, I couldn't connect to the server.";
        }
    }

    async function handleSendMessage() {
        const text = chatInput.value.trim();
        if (!text) return;

        // 1. Add user message to UI
        appendMessage(text, 'user');
        chatInput.value = '';

        // 2. Add loading state
        const loadingId = 'loading-' + Date.now();
        const loadingDiv = document.createElement('div');
        loadingDiv.classList.add('message', 'bot-message');
        loadingDiv.id = loadingId;
        loadingDiv.innerHTML = '<span class="material-symbols-outlined" style="font-size: 16px; vertical-align: middle; margin-right: 4px; animation: spin 1s linear infinite;">sync</span>Thinking...';
        chatbotMessages.appendChild(loadingDiv);
        chatbotMessages.scrollTop = chatbotMessages.scrollHeight;

        // 3. Fetch response from Backend (which talks to Groq and MongoDB)
        const responseText = await fetchLlama3Response(text);

        // 4. Replace loading state
        const placeholder = document.getElementById(loadingId);
        if (placeholder) {
            placeholder.textContent = responseText;
        } else {
            appendMessage(responseText, 'bot');
        }
        chatbotMessages.scrollTop = chatbotMessages.scrollHeight;
    }

    if (sendChatBtn && chatInput) {
        // Auto-resize textarea as user types
        chatInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
        });

        sendChatBtn.addEventListener('click', handleSendMessage);
        
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault(); // Prevent new line on regular Enter
                handleSendMessage();
                // Reset height after sending
                chatInput.style.height = 'auto';
            }
        });
    }
});
