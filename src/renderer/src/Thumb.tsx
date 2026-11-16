// Miniatura de página renderizada sob demanda (quando entra na tela).
import { useEffect, useRef, useState } from "react";
import { engine, type PageInfo } from "./api.ts";
import { useApp } from "./state.tsx";

export function Thumb({ index, info, width }: { index: number; info: PageInfo; width: number }) {
  const { doc } = useApp();
  const ref = useRef<HTMLCanvasElement>(null);
  const [seen, setSeen] = useState(false);
  const scale = width / info.width;
  const h = info.height * scale;

  useEffect(() => {
    const el = ref.current!;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setSeen(true); }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!seen || !doc) return;
    let dead = false;
    engine.render(index, scale * (window.devicePixelRatio || 1)).then((img) => {
      if (dead || !ref.current) return;
      ref.current.width = img.width; ref.current.height = img.height;
      ref.current.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
    }).catch(() => {});
    return () => { dead = true; };
  }, [seen, doc?.rev, index, scale]); // eslint-disable-line react-hooks/exhaustive-deps

  return <canvas ref={ref} className="thumb" style={{ width, height: h }} />;
}
