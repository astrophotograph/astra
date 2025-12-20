/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./templates/**/*.html", // Path to your HTML templates
    "./static/**/*.js",      // Path to JavaScript files (if using Tailwind in JS)
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};