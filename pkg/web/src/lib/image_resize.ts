const MAX_IMAGE_DIMENSION = 2048;
const JPEG_QUALITY = 0.8;

export async function resizeImageForCapture(image: File): Promise<File> {
  const bitmap = await createImageBitmap(image);
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");

  if (!context) {
    bitmap.close();
    throw new Error("Your browser could not prepare this image.");
  }

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  return new File([jpeg], jpegFileName(image.name), {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

function jpegFileName(fileName: string) {
  const extensionIndex = fileName.lastIndexOf(".");
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  return `${stem || "scorecard"}.jpg`;
}
