export default {
  plugins: {
    /**
     * Tailwind v4 iškėlė PostCSS įskiepį į ATSKIRĄ paketą.
     *
     * Palikus `tailwindcss: {}` build'as krenta su „PostCSS plugin has moved" -
     * tai pirmas dalykas, kurį pastebi Dependabot PR, ir vienintelis, kurį CI
     * apskritai gali pamatyti. Likusi migracijos dalis (klasių pervadinimai)
     * CI'ui nematoma, todėl aprašyta žemiau ir README.
     */
    "@tailwindcss/postcss": {},
    autoprefixer: {},
  },
};
