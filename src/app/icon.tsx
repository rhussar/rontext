import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #6ee7b7 0%, #7dd3fc 50%, #c4b5fd 100%)",
          borderRadius: 96,
        }}
      >
        <span
          style={{
            fontSize: 280,
            fontWeight: 700,
            color: "white",
            fontFamily: "sans-serif",
          }}
        >
          M
        </span>
      </div>
    ),
    size,
  );
}
