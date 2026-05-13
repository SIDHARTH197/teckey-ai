const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, './')));

// Fallback to serve index.html for any unknown routes (important for SPAs and clean URLs)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error. Please ensure MONGODB_URI in .env is correct:', err));

// Mongoose Schemas
const knowledgeSchema = new mongoose.Schema({
  topic: { type: String, required: true },
  content: { type: String, required: true },
  addedAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  role: String,
  content: String
});

const conversationSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  messages: [messageSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Conversation = mongoose.model('Conversation', conversationSchema);
const Knowledge = mongoose.model('Knowledge', knowledgeSchema);

// Initial System Prompt
const SYSTEM_PROMPT = {
  role: 'system',
  content: 'You are an intelligent, helpful, and concise AI customer support assistant for Teckey. Teckey provides digital marketing, web development, and an advanced e-commerce analytics dashboard. Use the provided [FACTS] to answer accurately. If you don\'t know something, say so.'
};

// API Route for Admin to "feed" data
app.post('/api/admin/feed', async (req, res) => {
  const { adminKey, topic, content } = req.body;

  if (adminKey !== process.env.ADMIN_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin Key' });
  }

  try {
    const newKnowledge = new Knowledge({ topic, content });
    await newKnowledge.save();
    res.json({ message: 'Knowledge added successfully!' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save knowledge' });
  }
});

// API Route to handle chat messages
app.post('/api/chat', async (req, res) => {
  const { sessionId, message, adminKey } = req.body;
  const isAdmin = (adminKey === process.env.ADMIN_SECRET_KEY);

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }

  try {
    // 1. Fetch relevant knowledge from MongoDB
    const allKnowledge = await Knowledge.find({});
    const contextFacts = allKnowledge.map(k => `[FACT: ${k.topic}] ${k.content}`).join('\n');

    // 2. Manage Conversation
    let conversation = await Conversation.findOne({ sessionId });
    if (!conversation) {
      conversation = new Conversation({
        sessionId,
        messages: [SYSTEM_PROMPT]
      });
    }

    // Add user message
    const userMsg = { role: 'user', content: message };
    conversation.messages.push(userMsg);

    // 3. Prepare AI Payload
    const messagesForGroq = [
      { role: 'system', content: SYSTEM_PROMPT.content + (contextFacts ? '\n\nAdditional Facts:\n' + contextFacts : '') },
      ...conversation.messages.slice(-10).map(msg => ({ role: msg.role, content: msg.content }))
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: messagesForGroq,
        temperature: 0.7,
        max_tokens: 1024
      })
    });

    if (!response.ok) throw new Error(`Groq API Error: ${response.status}`);

    const data = await response.json();
    const botResponseContent = data.choices[0].message.content;

    // 4. Save to MongoDB ONLY if Admin
    if (isAdmin) {
      const botMsg = { role: 'assistant', content: botResponseContent };
      conversation.messages.push(botMsg);
      conversation.updatedAt = Date.now();
      await conversation.save();
    }

    res.json({ reply: botResponseContent });

  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ error: 'Failed to process chat message' });
  }
});

// API Route to load history
app.get('/api/history/:sessionId', async (req, res) => {
  try {
    const conversation = await Conversation.findOne({ sessionId: req.params.sessionId });
    if (conversation) {
      const historyToReturn = conversation.messages.filter(msg => msg.role !== 'system');
      res.json(historyToReturn);
    } else {
      res.json([]);
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
