export class MessageHandler {
  constructor() {
    this.listeners = new Map();
  }

  on(messageType, callback) {
    if (!this.listeners.has(messageType)) {
      this.listeners.set(messageType, []);
    }
    this.listeners.get(messageType).push(callback);
  }

  off(messageType, callback) {
    if (this.listeners.has(messageType)) {
      const callbacks = this.listeners.get(messageType);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  async handle(message, sender, sendResponse) {
    const callbacks = this.listeners.get(message.type);
    if (callbacks && callbacks.length > 0) {
      for (const callback of callbacks) {
        try {
          const result = await callback(message, sender);
          if (result !== undefined) {
            sendResponse(result);
            return true;
          }
        } catch (error) {
          console.error(`Error handling message ${message.type}:`, error);
          sendResponse({ error: error.message });
          return true;
        }
      }
    }
    return false;
  }

  send(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
  }

  sendToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
  }

  broadcast(message) {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      });
    });
  }
}

export const messageHandler = new MessageHandler();
