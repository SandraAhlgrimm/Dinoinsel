const fs = require("node:fs");

function browserOptions() {
  const explicit = process.env.CHROME_PATH;
  if (explicit && !fs.existsSync(explicit)) throw new Error("CHROME_PATH does not point to an existing browser executable.");
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath = explicit || (process.platform === "darwin" && fs.existsSync(macChrome) ? macChrome : undefined);
  return {
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"]
  };
}

module.exports = { browserOptions };
