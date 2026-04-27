import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function fetchIcon(name: string, size: number): Promise<string | null> {
  const key = `${name}@${size}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = invoke<string | null>("resolve_icon", { name, size })
    .then((result) => {
      cache.set(key, result ?? null);
      inflight.delete(key);
      return result ?? null;
    })
    .catch(() => {
      cache.set(key, null);
      inflight.delete(key);
      return null;
    });
  inflight.set(key, promise);
  return promise;
}

type Props = {
  name: string;
  size?: number;
  fallback: string;
  className?: string;
  alt?: string;
};

export function SystemIcon({
  name,
  size = 32,
  fallback,
  className,
  alt = "",
}: Props) {
  const cached = cache.get(`${name}@${size}`);
  const [src, setSrc] = useState<string>(cached ?? fallback);

  useEffect(() => {
    let cancelled = false;
    fetchIcon(name, size).then((resolved) => {
      if (!cancelled && resolved) setSrc(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [name, size]);

  return <img src={src} alt={alt} className={className} />;
}
