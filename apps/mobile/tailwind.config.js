import nativewind from "nativewind/preset";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./App.tsx", "./src/**/*.{ts,tsx}"],
  presets: [nativewind],
  theme: {
    extend: {}
  },
  plugins: []
};
