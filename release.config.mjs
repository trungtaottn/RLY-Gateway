export default {
  branches: [
    { name: "main" },
    { name: "dev", prerelease: "beta" },
  ],
  tagFormat: "v${version}",
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/github",
      {
        failComment: false,
        successComment: false,
      },
    ],
  ],
};
