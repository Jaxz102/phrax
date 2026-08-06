import githubTools from "@github-tools/eve-extension";

export default githubTools({
  connector: process.env.GITHUB_CONNECTOR ?? "github/phrax",
  preset: "code-review",
  author: {
    name: "Phrax",
    email: "phrax[bot]@users.noreply.github.com",
  },
});
