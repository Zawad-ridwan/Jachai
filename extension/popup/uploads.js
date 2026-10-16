// Images the person uploads from their own device (Images tab).
// They are kept in the popup's memory only (never in chrome.storage), so they
// disappear when the popup closes. Only a small preview goes into the Results list.

export const UPLOAD_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024; // matches the server's limit (about 4 MB of image data)
export const UPLOAD_MAX_FILES = 10; // how many can wait in the list at once
const THUMB_SIZE = 160; // longest side of the preview, in pixels

let nextId = 1;

const readAsBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** A small JPEG preview. Throws if the browser can't decode the file as an image. */
async function makeThumb(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, THUMB_SIZE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs get a white background instead of black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { thumb: canvas.toDataURL('image/jpeg', 0.8) };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Checks and reads the chosen files. Returns the images that are fine plus a
 * plain-English problem for each one that isn't, so good files are kept even
 * if some are rejected.
 */
export async function readUploads(fileList, alreadyHave = 0) {
  const accepted = [];
  const problems = [];
  for (const file of fileList) {
    const name = file.name || 'image';
    if (alreadyHave + accepted.length >= UPLOAD_MAX_FILES) {
      problems.push(`Only ${UPLOAD_MAX_FILES} uploads can be waiting at once, so ${name} was skipped.`);
      continue;
    }
    if (!UPLOAD_TYPES.includes(file.type)) {
      problems.push(`${name} isn’t a supported image (PNG, JPEG, WebP or GIF).`);
      continue;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      problems.push(`${name} is ${mb(file.size)}. The maximum is 4 MB.`);
      continue;
    }
    try {
      const [{ thumb }, data] = await Promise.all([makeThumb(file), readAsBase64(file)]);
      accepted.push({ id: `up-${nextId++}`, name, mimeType: file.type, size: file.size, data, thumb });
    } catch {
      problems.push(`${name} couldn’t be opened as an image.`);
    }
  }
  return { accepted, problems };
}
