import { useEffect, useState } from "react";

/**
 * Konva's <Image> node needs an actual loaded HTMLImageElement, not a
 * URL string - this loads one and gives it back once ready. Returns
 * null while loading (or if the url is missing/fails), which callers
 * use to skip rendering until the image is actually available.
 */
export function useHtmlImage(url) {
  const [image, setImage] = useState(null);

  useEffect(() => {
    if (!url) {
      setImage(null);
      return;
    }
    const img = new window.Image();
    // Without this, the browser loads a cross-origin image (the
    // backend serves uploads from a different port/origin than the
    // frontend) in plain, non-CORS mode - which "taints" any canvas
    // it's drawn onto, and calling .toDataURL() on a tainted canvas
    // throws a SecurityError. The backend already sends permissive
    // CORS headers (see backend/app/main.py's CORSMiddleware), but
    // that only matters if the browser actually requests the image
    // in CORS mode in the first place - this is what does that, and
    // it has to be set BEFORE src, not after, since the request is
    // already underway once src is assigned.
    img.crossOrigin = "anonymous";
    img.onload = () => setImage(img);
    img.onerror = () => setImage(null);
    img.src = url;

    return () => setImage(null);
  }, [url]);

  return image;
}
