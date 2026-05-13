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

    // 1. Session Management
    const SESSION_KEY = 'teckeySessionId';
    let sessionId = localStorage.getItem(SESSION_KEY);
    if (!sessionId) {
        sessionId = 'session_' + Math.random().toString(36).substring(2, 15);
        localStorage.setItem(SESSION_KEY, sessionId);
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
            const response = await fetch(`http://localhost:3000/api/history/${sessionId}`);
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
        try {
            // Call our Node.js backend instead of calling Groq directly
            const response = await fetch('http://localhost:3000/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    sessionId: sessionId,
                    message: userMessage
                })
            });

            if (!response.ok) {
                throw new Error(`Backend Error: ${response.status}`);
            }

            const data = await response.json();
            return data.reply;
        } catch (error) {
            console.error('Error fetching from backend:', error);
            return "I'm sorry, I couldn't connect to the server. Please make sure the Node.js backend is running.";
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
        sendChatBtn.addEventListener('click', handleSendMessage);
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleSendMessage();
            }
        });
    }
});
