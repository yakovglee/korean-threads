import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Тот же 문 из прямоугольников, что и в icon.svg: шрифт с хангылем для иконки не нужен.
export default function AppleIcon() {
  const u = 180 / 64;
  const box = (x: number, y: number, w: number, h: number) => ({
    position: "absolute" as const,
    left: x * u,
    top: y * u,
    width: w * u,
    height: h * u,
    background: "#ffffff",
    borderRadius: u,
  });
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", background: "#111111", display: "flex", position: "relative" }}>
        <div style={box(20, 10, 24, 4)} />
        <div style={box(20, 20, 24, 4)} />
        <div style={box(20, 10, 4, 14)} />
        <div style={box(40, 10, 4, 14)} />
        <div style={box(14, 28, 36, 4)} />
        <div style={box(30, 32, 4, 8)} />
        <div style={box(20, 42, 4, 12)} />
        <div style={box(20, 50, 26, 4)} />
      </div>
    ),
    size,
  );
}
