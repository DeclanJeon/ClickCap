/**
 * CDN Library Loader
 * Dynamically loads external libraries from CDN with caching and retry logic
 */

class CDNLoader {
  constructor() {
    this.loadedLibraries = new Map();
    this.loadingPromises = new Map();
  }

  /**
   * Load a library from CDN with caching
   * @param {string} name - Library name
   * @param {string} url - CDN URL
   * @param {Object} options - Loading options
   * @returns {Promise<Object>} - Loaded library
   */
  async loadLibrary(name, url, options = {}) {
    const {
      timeout = 10000,
      retries = 3,
      globalName = null, // Global variable name for the library
      integrity = null   // SRI integrity check
    } = options;

    // Return cached version if already loaded
    if (this.loadedLibraries.has(name)) {
      return this.loadedLibraries.get(name);
    }

    // Return existing promise if currently loading
    if (this.loadingPromises.has(name)) {
      return this.loadingPromises.get(name);
    }

    // Create loading promise
    const loadingPromise = this._loadWithRetry(name, url, {
      timeout,
      retries,
      globalName,
      integrity
    });

    this.loadingPromises.set(name, loadingPromise);

    try {
      const library = await loadingPromise;
      this.loadedLibraries.set(name, library);
      this.loadingPromises.delete(name);
      return library;
    } catch (error) {
      this.loadingPromises.delete(name);
      throw error;
    }
  }

  /**
   * Load library with retry logic
   */
  async _loadWithRetry(name, url, options) {
    const { timeout, retries, globalName, integrity } = options;
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`[CDN Loader] Loading ${name} (attempt ${attempt}/${retries}) from ${url}`);

        // Create script element
        const script = document.createElement('script');
        script.src = url;
        script.async = true;

        if (integrity) {
          script.integrity = integrity;
          script.crossOrigin = 'anonymous';
        }

        // Create timeout promise
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Timeout loading ${name}`)), timeout);
        });

        // Create load promise
        const loadPromise = new Promise((resolve, reject) => {
          script.onload = () => {
            // Remove script after loading
            document.head.removeChild(script);

            // Get library from global scope if specified
            if (globalName) {
              const library = window[globalName];
              if (library) {
                resolve(library);
              } else {
                reject(new Error(`Library ${name} loaded but ${globalName} not found in global scope`));
              }
            } else {
              resolve(true);
            }
          };

          script.onerror = () => {
            document.head.removeChild(script);
            reject(new Error(`Failed to load ${name} from ${url}`));
          };
        });

        // Add script to document
        document.head.appendChild(script);

        // Wait for either load or timeout
        await Promise.race([loadPromise, timeoutPromise]);

        console.log(`[CDN Loader] Successfully loaded ${name}`);
        return globalName ? window[globalName] : true;

      } catch (error) {
        lastError = error;
        console.warn(`[CDN Loader] Attempt ${attempt} failed for ${name}:`, error.message);

        if (attempt < retries) {
          // Wait before retrying with exponential backoff
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Failed to load ${name} after ${retries} attempts. Last error: ${lastError.message}`);
  }

  /**
   * Preload essential libraries
   */
  async preloadLibraries() {
    const essentialLibraries = [
      {
        name: 'gif.js',
        url: 'https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js',
        globalName: 'GIF',
        options: {
          timeout: 15000,
          retries: 3
        }
      }
    ];

    try {
      const results = await Promise.allSettled(
        essentialLibraries.map(lib =>
          this.loadLibrary(lib.name, lib.url, lib.options)
        )
      );

      results.forEach((result, index) => {
        const lib = essentialLibraries[index];
        if (result.status === 'fulfilled') {
          console.log(`[CDN Loader] Preloaded ${lib.name}`);
        } else {
          console.warn(`[CDN Loader] Failed to preload ${lib.name}:`, result.reason);
        }
      });
    } catch (error) {
      console.warn('[CDN Loader] Preloading failed:', error);
    }
  }

  /**
   * Check if library is loaded
   */
  isLoaded(name) {
    return this.loadedLibraries.has(name);
  }

  /**
   * Get loaded library
   */
  getLibrary(name) {
    return this.loadedLibraries.get(name);
  }

  /**
   * Clear cached libraries
   */
  clearCache() {
    this.loadedLibraries.clear();
    console.log('[CDN Loader] Cache cleared');
  }
}

// Create global instance
const cdnLoader = new CDNLoader();

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CDNLoader, cdnLoader };
} else if (typeof window !== 'undefined') {
  window.CDNLoader = CDNLoader;
  window.cdnLoader = cdnLoader;
}

// Service Worker environment
if (typeof self !== 'undefined' && !typeof window !== 'undefined') {
  self.CDNLoader = CDNLoader;
  self.cdnLoader = cdnLoader;
}