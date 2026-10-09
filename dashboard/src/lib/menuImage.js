const IMAGE_PREFIX = "mfimg:";
const MAX_EDGE = 720;
const MAX_CHARS = 140000;

export function readMenuImage(item) {
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  const tag = tags.find((entry) => String(entry || "").startsWith(IMAGE_PREFIX));
  if (!tag) return "";
  return String(tag).slice(IMAGE_PREFIX.length);
}

export function writeMenuImageTags(tags, image) {
  const next = (Array.isArray(tags) ? tags : []).filter(
    (entry) => !String(entry || "").startsWith(IMAGE_PREFIX)
  );
  const value = String(image || "").trim();
  if (value) next.push(`${IMAGE_PREFIX}${value}`);
  return next;
}

export function compressMenuImage(file) {
  const type = String(file?.type || "");
  if (!/^image\/(jpeg|png|webp)$/.test(type)) {
    return Promise.reject(new Error("La foto tiene que ser JPG, PNG o WEBP."));
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const longest = Math.max(image.width, image.height) || 1;
      const scale = Math.min(1, MAX_EDGE / longest);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("No se pudo preparar la foto."));
        return;
      }
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
      if (dataUrl.length > MAX_CHARS) {
        reject(new Error("La foto quedó muy pesada. Probá con una más chica."));
        return;
      }
      resolve(dataUrl);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo leer la foto."));
    };
    image.src = url;
  });
}
