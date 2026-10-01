import type {
  ActionNode,
  Behavior,
  MascotConfig,
  Pose,
  BehaviorReference,
  ActionType,
} from "./types";
import type { Hotspot } from "./Hotspot";

export class XMLParser {
  static async loadConfig(mascotName: string): Promise<MascotConfig> {
    const basePath = `/mascot_pack/${mascotName}`;
    const [actionsXmlRes, behaviorsXmlRes] = await Promise.all([
      fetch(`${basePath}/actions.xml`),
      fetch(`${basePath}/behaviors.xml`),
    ]);

    if (!actionsXmlRes.ok || !behaviorsXmlRes.ok) {
      throw new Error(`加载配置失败: ${mascotName}.`);
    }

    const actionsRaw = await actionsXmlRes.text();
    const behaviorsRaw = await behaviorsXmlRes.text();

    if (actionsRaw.trim().toLowerCase().startsWith("<!doctype html>")) {
      throw new Error(
        `[XMLParser] 加载 ${mascotName} 的 actions.xml 失败：Vite 返回了 HTML fallback。`,
      );
    }

    const cleanActionsStr = actionsRaw.replace(/xmlns=".*?"/g, "");
    const cleanBehaviorsStr = behaviorsRaw.replace(/xmlns=".*?"/g, "");

    const parser = new DOMParser();
    const actionsDoc = parser.parseFromString(cleanActionsStr, "text/xml");
    const behaviorsDoc = parser.parseFromString(cleanBehaviorsStr, "text/xml");

    return {
      actions: this.parseActions(actionsDoc),
      behaviors: this.parseBehaviors(behaviorsDoc),
    };
  }

  private static getTag(node: Document | Element, name: string): Element[] {
    const nsNodes = node.getElementsByTagNameNS("*", name);
    if (nsNodes && nsNodes.length > 0) return Array.from(nsNodes);
    return Array.from(node.getElementsByTagName(name));
  }

  private static parseActions(doc: Document): Record<string, ActionNode> {
    const actions: Record<string, ActionNode> = {};
    const lists = this.getTag(doc, "ActionList");

    for (const list of lists) {
      for (let i = 0; i < list.children.length; i++) {
        const node = list.children[i];
        const localName = node.localName || node.tagName;
        if (localName === "Action" || localName.endsWith(":Action")) {
          const action = this.parseActionNode(node);
          if (action.name) {
            actions[action.name] = action;
          }
        }
      }
    }
    return actions;
  }

  private static parseActionNode(node: Element): ActionNode {
    const tagName = node.localName || node.tagName;
    if (tagName === "ActionReference" || tagName.endsWith(":ActionReference")) {
      const attributes: Record<string, string> = {};
      for (let i = 0; i < node.attributes.length; i++) {
        const attr = node.attributes.item(i);
        if (attr) attributes[attr.name] = attr.value;
      }
      return {
        type: "ActionReference",
        referenceName: node.getAttribute("Name") || "",
        condition: node.getAttribute("Condition") || undefined,
        duration: node.getAttribute("Duration") || undefined,
        initialVX: node.getAttribute("InitialVX") || undefined,
        initialVY: node.getAttribute("InitialVY") || undefined,
        attributes,
      };
    }

    const type = (node.getAttribute("Type") || "Stay") as ActionType;
    const action: ActionNode = {
      name: node.getAttribute("Name") || undefined,
      type,
      className: node.getAttribute("Class") || undefined,
      borderType: node.getAttribute("BorderType") || undefined,
      condition: node.getAttribute("Condition") || undefined,
      // libshijima's sequence reads "Loops"; the shipped packs write "Loop".
      loop: node.getAttribute("Loops") === "true" || node.getAttribute("Loop") === "true",
      // Embedded 物理参数
      initialVX: node.getAttribute("InitialVX") || undefined,
      initialVY: node.getAttribute("InitialVY") || undefined,
      attributes: this.readAttributes(node),
    };

    if (type === "Sequence" || type === "Select") {
      action.children = [];
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const childTag = child.localName || child.tagName;
        if (
          childTag === "Action" ||
          childTag === "ActionReference" ||
          childTag.endsWith("Action") ||
          childTag.endsWith("ActionReference")
        ) {
          action.children.push(this.parseActionNode(child));
        }
      }
    } else {
      const animationNodes = Array.from(node.children).filter((child) =>
        (child.localName || child.tagName) === "Animation",
      );
      action.animations = animationNodes.map((animNode) => ({
        condition: animNode.getAttribute("Condition") || undefined,
        poses: this.parsePoses(animNode),
        hotspots: this.parseHotspots(animNode),
      }));
      action.poses = action.animations[0]?.poses || [];
    }

    return action;
  }

  private static readAttributes(node: Element): Record<string, string> {
    const attributes: Record<string, string> = {};
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes.item(i);
      if (attr) attributes[attr.name] = attr.value;
    }
    return attributes;
  }

  private static parsePoses(animNode: Element): Pose[] {
    const poses: Pose[] = [];
    const poseNodes = this.getTag(animNode, "Pose");
    for (let i = 0; i < poseNodes.length; i++) {
      const pNode = poseNodes[i];
      const anchor = (pNode.getAttribute("ImageAnchor") || "0,0").split(",");
      const vel = (pNode.getAttribute("Velocity") || "0,0").split(",");
      poses.push({
        image: pNode.getAttribute("Image") || "",
        imageAnchor: { x: parseInt(anchor[0]), y: parseInt(anchor[1]) },
        velocity: { x: parseFloat(vel[0]), y: parseFloat(vel[1]) },
        duration: parseInt(pNode.getAttribute("Duration") || "1"),
      });
    }
    return poses;
  }

  /** `<Hotspot Shape Origin Size Behavior>` children of an animation. libshijima's
   *  parser warns and drops a hotspot with an unknown shape or no behaviour, so the
   *  same entries are skipped here rather than guessed at. */
  private static parseHotspots(animNode: Element): Hotspot[] | undefined {
    const hotspots: Hotspot[] = [];
    const nodes = this.getTag(animNode, "Hotspot");
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const shape = (node.getAttribute("Shape") || "").trim();
      if (shape !== "Ellipse" && shape !== "Rectangle") continue;
      const behavior = (node.getAttribute("Behavior") || "").trim();
      if (!behavior) continue;
      const origin = (node.getAttribute("Origin") || "").split(",");
      const size = (node.getAttribute("Size") || "").split(",");
      const originX = parseFloat(origin[0]);
      const originY = parseFloat(origin[1]);
      const sizeX = parseFloat(size[0]);
      const sizeY = parseFloat(size[1]);
      if (![originX, originY, sizeX, sizeY].every((value) => Number.isFinite(value))) continue;
      hotspots.push({
        shape,
        origin: { x: originX, y: originY },
        size: { x: sizeX, y: sizeY },
        behavior,
      });
    }
    return hotspots.length > 0 ? hotspots : undefined;
  }

  private static parseBehaviors(doc: Document): Behavior[] {
    const behaviors: Behavior[] = [];
    const behaviorNodes = this.getTag(doc, "Behavior");

    for (let i = 0; i < behaviorNodes.length; i++) {
      const node = behaviorNodes[i];
      const name = node.getAttribute("Name");
      if (!name) continue;

      const frequency = parseInt(node.getAttribute("Frequency") || "0");
      const hidden = node.getAttribute("Hidden") === "true";

      let condition: string | undefined = undefined;
      const parent = node.parentNode as Element;
      if (
        parent &&
        (parent.localName === "Condition" || parent.tagName === "Condition")
      ) {
        condition = parent.getAttribute("Condition") || undefined;
      }

      const nextBehaviors: BehaviorReference[] = [];
      let addNext = true;
      const nextList = this.getTag(node, "NextBehaviorList")[0];
      if (nextList) {
        addNext = nextList.getAttribute("Add") !== "false";
        const refs = this.getTag(nextList, "BehaviorReference");
        for (let j = 0; j < refs.length; j++) {
          nextBehaviors.push({
            name: refs[j].getAttribute("Name") || "",
            frequency: parseInt(refs[j].getAttribute("Frequency") || "0"),
            condition: refs[j].getAttribute("Condition") || undefined,
          });
        }
      }

      behaviors.push({ name, frequency, hidden, condition, nextBehaviors, addNext });
    }
    return behaviors;
  }
}
