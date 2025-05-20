// tailwind.config.ts
import type { Config } from 'tailwindcss'

const config: Config = {
  /** Use the `.dark` class to switch themes */
  darkMode: 'class',

  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],

  theme: {
    extend: {},
  },

  plugins: [],
}

export default config