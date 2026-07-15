(function () {
  const DEFAULTS = {
    maxWidth: 800,
    maxHeight: 800,
    quality: 0.75,
    mimeType: 'image/jpeg',
  };

  function imageFileName(file) {
    const base = String(file.name || 'vehicle-photo').replace(/\.[^.]+$/, '');
    return `${base}.jpg`;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Image could not be loaded'));
      };
      img.src = url;
    });
  }

  function canvasBlob(canvas, mimeType, quality) {
    return new Promise(resolve => {
      canvas.toBlob(resolve, mimeType, quality);
    });
  }

  async function compressImageFile(file, options = {}) {
    if (!file || !String(file.type || '').startsWith('image/')) return file;
    if (file.type === 'image/svg+xml') return file;
    if (file.__unitNavigatorCompressed) return file;

    const settings = { ...DEFAULTS, ...options };

    try {
      const img = await loadImage(file);
      const scale = Math.min(
        1,
        settings.maxWidth / img.naturalWidth,
        settings.maxHeight / img.naturalHeight
      );
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(img, 0, 0, width, height);

      const blob = await canvasBlob(canvas, settings.mimeType, settings.quality);
      if (!blob) return file;

      const compressed = new File([blob], imageFileName(file), {
        type: settings.mimeType,
        lastModified: Date.now(),
      });
      Object.defineProperty(compressed, '__unitNavigatorCompressed', { value: true });
      return compressed;
    } catch (err) {
      console.warn('Photo compression failed, uploading original', err);
      return file;
    }
  }

  async function compressImageFiles(files, options = {}) {
    const list = Array.from(files || []).filter(file => file && String(file.type || '').startsWith('image/'));
    const compressed = [];
    for (const file of list) {
      compressed.push(await compressImageFile(file, options));
    }
    return compressed;
  }

  window.UNImage = {
    compressImageFile,
    compressImageFiles,
  };
})();
