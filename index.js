// WhatsApp Connection Script using Baileys with automatic URL fetching
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const got = require('got');
const axios = require('axios');
const fetch = import('node-fetch');
const { format } = require('util');

// Configure logger with Pino
const logger = pino({ level: 'info' });

// Session file path
const SESSION_PATH = path.join(__dirname, 'session');
if (!fs.existsSync(SESSION_PATH)) {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

// Create temp directory for downloaded files
const TEMP_PATH = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_PATH)) {
  fs.mkdirSync(TEMP_PATH, { recursive: true });
}

// Maximum content size (100MB for automatic fetching to prevent abuse)
const MAX_CONTENT_SIZE = 100 * 1024 * 1024;

// Helper function to add https if needed
function addHttpsIfNeeded(link) {
  if (!/^https?:\/\//i.test(link)) {
    link = "https://" + link;
  }
  return link;
}

// Helper function to format file size
function formatSize(size) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (size >= 1024 && i < 4) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(2)} ${units[i]}`;
}

// Enhanced GET handler with multiple fallback options
async function getHandler(url, sock, chatId) {
  try {
    // Standardize URL format
    url = addHttpsIfNeeded(url);
    const { href: finalUrl, origin } = new URL(url);
    let response, content;
    
    // First attempt: using got
    try {
      logger.info(`Attempting to fetch with got: ${finalUrl}`);
      response = await got(finalUrl, { 
        headers: { 'referer': origin },
        timeout: { request: 10000 } // 10 second timeout
      });
      content = response.body;
      logger.info('Successfully fetched with got');
    } catch (error) {
      logger.warn(`Got fetch failed: ${error.message}`);
      
      // Second attempt: using node-fetch
      try {
        logger.info(`Attempting to fetch with node-fetch: ${finalUrl}`);
        response = await fetch(finalUrl, { 
          headers: { 'referer': origin },
          timeout: 10000 // 10 second timeout
        });
        content = await response.text();
        logger.info('Successfully fetched with node-fetch');
      } catch (error) {
        logger.warn(`Node-fetch failed: ${error.message}`);
        
        // Third attempt: using axios
        try {
          logger.info(`Attempting to fetch with axios: ${finalUrl}`);
          response = await axios.get(finalUrl, { 
            headers: { 'referer': origin },
            responseType: 'arraybuffer',
            timeout: 10000 // 10 second timeout
          });
          
          if (response.headers['content-type']?.includes('text') || response.headers['content-type']?.includes('json')) {
            content = response.data.toString('utf8');
          } else {
            content = response.data;
          }
          logger.info('Successfully fetched with axios');
        } catch (error) {
          logger.error(`All fetch methods failed: ${error.message}`);
          await sock.sendMessage(chatId, { text: `❌ Could not fetch: ${error.message}` });
          return;
        }
      }
    }

    const contentType = response.headers['content-type'] || '';
    const contentLength = parseInt(response.headers['content-length'] || '0');

    // Check file size limit
    if (contentLength > MAX_CONTENT_SIZE) {
      await sock.sendMessage(chatId, { 
        text: `⚠️ File too large (${formatSize(contentLength)}). Maximum size: ${formatSize(MAX_CONTENT_SIZE)}` 
      });
      return;
    }

    // Handle binary content (non-text, non-json)
    if (!contentType.includes('text') && !contentType.includes('json')) {
      logger.info(`Sending binary file with content-type: ${contentType}`);
      const fileName = finalUrl.split('/').pop().split('?')[0] || 'downloaded_file';
      const filePath = path.join(TEMP_PATH, `${Date.now()}_${fileName}`);
      
      // Save the file
      if (Buffer.isBuffer(content)) {
        fs.writeFileSync(filePath, content);
      } else if (typeof content === 'string') {
        fs.writeFileSync(filePath, Buffer.from(content));
      } else {
        fs.writeFileSync(filePath, Buffer.from(content.toString()));
      }
      
      // Determine media type and send appropriately
      if (contentType.startsWith('image/')) {
        await sock.sendMessage(chatId, {
          image: { url: filePath },
          caption: `🖼️ ${finalUrl}`
        });
      } else if (contentType.startsWith('video/')) {
        await sock.sendMessage(chatId, {
          video: { url: filePath },
          caption: `🎬 ${finalUrl}`
        });
      } else if (contentType.startsWith('audio/')) {
        await sock.sendMessage(chatId, {
          audio: { url: filePath },
          mimetype: contentType
        });
      } else {
        await sock.sendMessage(chatId, {
          document: { url: filePath },
          mimetype: contentType,
          fileName: fileName
        });
      }
      
      logger.info(`Binary file sent successfully`);
      return;
    }

    // Handle text/json content
    let formattedContent;
    try {
      // Try to parse and format JSON
      if (contentType.includes('json') || (typeof content === 'string' && content.trim().startsWith('{'))) {
        const jsonData = JSON.parse(typeof content === 'string' ? content : content.toString('utf8'));
        formattedContent = format(jsonData);
        logger.info('Successfully parsed JSON content');
      } else {
        // Handle as plain text
        formattedContent = typeof content === 'string' ? content : content.toString('utf8');
        logger.info('Handling as plain text content');
      }
    } catch (error) {
      logger.warn(`JSON parsing failed, treating as text: ${error.message}`);
      formattedContent = typeof content === 'string' ? content : content.toString('utf8');
    }

    // Truncate if too long
    if (formattedContent.length > 65536) {
      formattedContent = formattedContent.slice(0, 65536) + '\n... (content truncated)';
    }

    // Send the text content
    await sock.sendMessage(chatId, { text: formattedContent });
    logger.info(`Text content sent successfully (${formattedContent.length} characters)`);

  } catch (error) {
    logger.error(`Unexpected error in getHandler: ${error.message}`);
    await sock.sendMessage(chatId, { 
      text: `❌ Error: ${error.message}`
    });
  }
}

// Start WhatsApp connection
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  
  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsApp Bot', 'Chrome', '1.0.0'],
    markOnlineOnConnect: true
  });
  
  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      logger.info({ shouldReconnect }, 'Connection closed');
      
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      logger.info('Connection opened successfully!');
    }
  });
  
  // URL regex for detecting links (improved to avoid false positives)
  const urlRegex = /(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/gi;
  
  // Message handler - now processes ALL messages including self-messages
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    
    // Process both incoming and self-messages
    if (m.type === 'notify') {
      // Send read receipt for non-self messages
      if (!msg.key.fromMe) {
        await sock.readMessages([msg.key]);
      }
      
      // Extract message content
      const messageType = Object.keys(msg.message || {})[0];
      let messageContent = '';
      
      if (messageType === 'conversation') {
        messageContent = msg.message.conversation;
      } else if (messageType === 'extendedTextMessage') {
        messageContent = msg.message.extendedTextMessage.text;
      } else if (messageType === 'imageMessage' && msg.message.imageMessage.caption) {
        messageContent = msg.message.imageMessage.caption;
      } else if (messageType === 'videoMessage' && msg.message.videoMessage.caption) {
        messageContent = msg.message.videoMessage.caption;
      }
      
      if (!messageContent) return;
      
      // Find URLs in the message
      const urls = messageContent.match(urlRegex);
      if (urls && urls.length > 0) {
        // Automatically fetch the first URL found
        const firstUrl = urls[0];
        logger.info(`Auto-fetching URL: ${firstUrl}`);
        await getHandler(firstUrl, sock, msg.key.remoteJid);
      }
    }
  });
  
  // Clean up temp files periodically (every hour)
  setInterval(() => {
    try {
      const files = fs.readdirSync(TEMP_PATH);
      const now = Date.now();
      for (const file of files) {
        const filePath = path.join(TEMP_PATH, file);
        const stats = fs.statSync(filePath);
        // Delete files older than 2 hours
        if (now - stats.mtimeMs > 2 * 60 * 60 * 1000) {
          fs.unlinkSync(filePath);
          logger.info(`Deleted old temp file: ${file}`);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error cleaning up temp files');
    }
  }, 60 * 60 * 1000);
  
  return sock;
}

// Start the connection
connectToWhatsApp()
  .then(() => {
    logger.info('WhatsApp connection process started');
  })
  .catch(err => {
    logger.error({ err }, 'Failed to connect');
  });
