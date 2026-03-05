import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) =>
    `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

// --- Image ref parsing ---

export interface ImageRef {
  imageKey: string;
  messageId: string;
  fullMatch: string;
}

/** Extract all image references from message content. */
export function parseImageRefs(content: string): ImageRef[] {
  const re = /\[图片 image_key=(\S+) message_id=(\S+)\]/g;
  const refs: ImageRef[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    refs.push({
      imageKey: match[1],
      messageId: match[2],
      fullMatch: match[0],
    });
  }
  return refs;
}

/**
 * Strip successfully downloaded image refs from content.
 * Downloaded refs become `[图片]`; failed ones keep full metadata for MCP fallback.
 */
export function stripImageRefs(content: string, downloadedKeys: Set<string>): string {
  return content.replace(
    /\[图片 image_key=(\S+) message_id=(\S+)\]/g,
    (fullMatch, imageKey: string) => {
      return downloadedKeys.has(imageKey) ? '[图片]' : fullMatch;
    },
  );
}

// --- File ref parsing (for DM file messages) ---

export interface FileRef {
  fileKey: string;
  messageId: string;
  fullMatch: string;
}

/** Parse DM file refs: [文件 file_key=... file_name=... message_id=...] */
export function parseDmFileRefs(content: string): Array<FileRef & { fileName: string }> {
  const re = /\[文件 file_key=(\S+) file_name=(\S+) message_id=(\S+)\]/g;
  const refs: Array<FileRef & { fileName: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    refs.push({
      fileKey: match[1],
      fileName: match[2],
      messageId: match[3],
      fullMatch: match[0],
    });
  }
  return refs;
}

