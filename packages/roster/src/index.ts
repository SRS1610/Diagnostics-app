import { buildApp } from "./app";

const PORT = Number(process.env.ROSTER_PORT ?? 4100);

buildApp().listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Roster API listening on http://localhost:${PORT}`);
});
