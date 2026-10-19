import { readFileSync } from "node:fs";
import { fixture, parseConfig } from "./engine-fixture.mjs";

export function realFixture(random = () => 0.5) {
  const f = fixture({ random });
  const configs = new Map(["Neuron", "Eviling"].map((name) => [name, parseConfig(
    readFileSync(`public/mascot_pack/${name}/actions.xml`, "utf8"),
    readFileSync(`public/mascot_pack/${name}/behaviors.xml`, "utf8"), name)]));
  const make = (name = "Neuron") => {
    const engine = f.createEngine(name);
    engine.config = configs.get(name);
    engine.x = 500; engine.y = 600;
    engine.cursorX = 700; engine.cursorY = 400;
    return engine;
  };
  return { ...f, make, configs };
}
