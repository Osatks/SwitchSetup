// The one place to change if the GitHub repository moves.
const REPO = "Osatks/SwitchSetup";

const repoUrl = `https://github.com/${REPO}`;
const downloadUrl = `${repoUrl}/releases/latest/download/SwitchSetup.exe`;

document.querySelectorAll("[data-repo-link]").forEach((a) => {
  a.href = repoUrl;
  a.target = "_blank";
  a.rel = "noopener";
});
document.querySelectorAll("[data-download]").forEach((a) => (a.href = downloadUrl));

// Show the latest version and size under the download button.
fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  .then((r) => (r.ok ? r.json() : null))
  .then((rel) => {
    if (!rel) return;
    const exe = rel.assets?.find((a) => a.name === "SwitchSetup.exe");
    const mb = exe ? ` · ${Math.round(exe.size / 1024 / 1024)} MB` : "";
    const date = new Date(rel.published_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    document.getElementById("relInfo").textContent = `Windows app ${rel.tag_name.replace(/^v/, "")} · ${date}${mb}`;
  })
  .catch(() => { });
