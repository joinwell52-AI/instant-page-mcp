import { createHash } from 'node:crypto';
import { AnswerError } from './field-rules.mjs';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const signatures = new Map([
  ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
  ['image/jpeg', Buffer.from([255, 216, 255])]
]);
const filenameUnsafe = /[\\/\u0000-\u001F\u007F]/u;

export function validAttachmentMetadata(data) {
  return data !== null && typeof data === 'object' &&
    typeof data.filename === 'string' && data.filename.trim() && [...data.filename].length <= 160 &&
    !filenameUnsafe.test(data.filename) && signatures.has(data.content_type) &&
    Number.isSafeInteger(data.size) && data.size > 0 && data.size <= MAX_IMAGE_BYTES &&
    typeof data.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(data.sha256);
}

export async function readImageForm(bytes, contentType, attachment) {
  let fields;
  try {
    fields = await new Request('http://localhost/', {
      method:'POST', headers:{'content-type':contentType}, body:bytes
    }).formData();
  } catch {
    throw new AnswerError('图片提交格式无效。', 'invalid_multipart');
  }
  const form = new URLSearchParams();
  let file;
  for (const [name,value] of fields) {
    if (name === 'attachment' && typeof value !== 'string' && file === undefined) file = value;
    else if (name !== 'attachment' && typeof value === 'string') form.append(name,value);
    else throw new AnswerError('请只附上一张图片。', 'invalid_attachment');
  }
  if (!file?.size) {
    if (attachment.required) throw new AnswerError('请附上原图。', 'attachment_required');
    return {form};
  }
  if (file.size > MAX_IMAGE_BYTES) throw new AnswerError('图片不能超过 10 MiB。', 'attachment_too_large');
  const image = Buffer.from(await file.arrayBuffer());
  const signature = signatures.get(file.type);
  if (!signature || !image.subarray(0,signature.length).equals(signature)) {
    throw new AnswerError('请选择 PNG 或 JPEG 图片。', 'invalid_attachment_type');
  }
  const safeName = file.name.split(/[\\/]/u).at(-1).replace(/[\u0000-\u001F\u007F]/gu,'').trim();
  const filename = [...safeName].slice(0,160).join('') || (file.type === 'image/png' ? 'image.png' : 'image.jpg');
  const metadata = {filename,content_type:file.type,size:image.length,
    sha256:createHash('sha256').update(image).digest('hex')};
  return {form,upload:{image,metadata}};
}
