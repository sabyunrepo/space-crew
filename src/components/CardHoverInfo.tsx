import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const cards = ".card, .seat-task, .draft-task, .character-card, .communication-card, .character-options button, .token-choice";
export function CardHoverInfo() {
  const [info, setInfo] = useState<{ src: string; label: string; detail: string; tokenLabel: string; tokenClass: string; left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const show = (event: Event) => {
      if (event instanceof PointerEvent && event.pointerType !== "mouse") return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(cards) : null;
      const img = target?.querySelector<HTMLImageElement>("img");
      if (!target || !img) { setInfo(null); return; }
      const rect = target.getBoundingClientRect();
      const token = target.querySelector<HTMLElement>(".task-order");
      setInfo({ src: img.src, label: img.alt || target.getAttribute("aria-label") || "카드",
        detail: target.getAttribute("title") || target.getAttribute("aria-label") || "",
        tokenLabel: token?.textContent?.trim() || "", tokenClass: token?.className || "",
        left: rect.right + 200 < innerWidth ? rect.right + 10 : Math.max(8, rect.left - 200),
        top: Math.max(8, Math.min(rect.top, innerHeight - 365)) });
    };
    const hide = () => setInfo(null);
    const leave = (event: PointerEvent) => { if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest(cards)) hide(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    document.addEventListener("pointerover", show);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusin", show);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerover", show); document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusin", show); document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide); document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide);
    };
  }, []);
  useLayoutEffect(() => {
    if (info) ref.current?.showPopover();
    else ref.current?.hidePopover();
  }, [info]);
  return createPortal(<div ref={ref} popover="manual" role="tooltip" aria-label="카드 정보" className="card-hover-info"
    style={{ left: info?.left, top: info?.top }}>
    {info && <><div className="card-hover-preview"><img src={info.src} alt="" />{info.tokenLabel && <span className={info.tokenClass}>{info.tokenLabel}</span>}</div><strong>{info.label}</strong>{info.detail && info.detail !== info.label && <p>{info.detail}</p>}</>}
  </div>, document.body);
}
