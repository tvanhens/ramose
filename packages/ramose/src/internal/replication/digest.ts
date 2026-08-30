const utf8 = new TextEncoder();

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const localDigest = async (material: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    utf8.encode(JSON.stringify(material)),
  );
  return base64Url(new Uint8Array(digest));
};
