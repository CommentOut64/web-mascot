/**
 * Japanese Shimeji XML Translator.
 *
 * Re-implementation of libshijima's translator (translator.cc) for the web.
 * Translates original Group Finity Japanese XML tags, attribute names, and
 * standard attribute values into Shimeji-ee standard English.
 */

export const JAPANESE_TO_ENGLISH_MAP: Record<string, string> = {
  // Elements
  "動作リスト": "ActionList",
  "動作": "Action",
  "動作参照": "ActionReference",
  "ポーズ": "Pose",
  "行動リスト": "BehaviorList",
  "行動": "Behavior",
  "次の行動リスト": "NextBehaviorList",
  "行動参照": "BehaviorReference",
  "マスコット": "Mascot",
  "アニメーション": "Animation",
  "条件": "Condition",

  // Attributes
  "名前": "Name",
  "値": "Value",
  "種類": "Type",
  "クラス": "Class",
  "組み込み": "Embedded",
  "枠": "BorderType",
  "目的地X": "TargetX",
  "目的地Y": "TargetY",
  "速度": "VelocityParam",
  "初速X": "InitialVX",
  "初速Y": "InitialVY",
  "重力": "Gravity",
  "空気抵抗X": "ResistanceX",
  "空気抵抗Y": "ResistanceY",
  "右向き": "LookRight",
  "IEの端X": "IeOffsetX",
  "IEの端Y": "IeOffsetY",
  "生まれる場所X": "BornX",
  "生まれる場所Y": "BornY",
  "生まれた時の行動": "BornBehavior",
  "繰り返し": "Loop",
  "画像": "Image",
  "基準座標": "ImageAnchor",
  "移動速度": "Velocity",
  "長さ": "Duration",
  "頻度": "Frequency",
  "定数": "Constant",
  "追加": "Add",
  "端X": "OffsetX",
  "端Y": "OffsetY",

  // Common Action & Behavior types / values
  "静止": "Stay",
  "固定": "Animate",
  "移動": "Move",
  "複合": "Sequence",
  "選択": "Select",
  "天井": "Ceiling",
  "壁": "Wall",
  "地面": "Floor",
  "落下する": "Fall",
  "ドラッグされる": "Dragged",
  "投げられる": "Thrown",
  "マウスの周りに集まる": "ChaseMouse",
};

/**
 * Remove UTF-8 BOM if present and translate Japanese Shimeji XML tags/attributes
 * into standard English Shimeji-ee XML format.
 */
export function translateShimejiXml(xmlText: string): string {
  if (!xmlText) return "";
  // 1. Strip UTF-8 BOM
  let clean = xmlText.replace(/^\uFEFF/, "");

  // Quick check: if no Japanese characters exist, return directly
  if (!/[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(clean)) {
    return clean;
  }

  // 2. Translate opening and closing tags
  for (const [jp, en] of Object.entries(JAPANESE_TO_ENGLISH_MAP)) {
    // Tag matching: <JP or </JP followed by space, slash or >
    clean = clean.replace(new RegExp(`(<|</)${jp}([\\s>/])`, "g"), `$1${en}$2`);
    // Attribute name matching: whitespace followed by JP=
    clean = clean.replace(new RegExp(`(\\s)${jp}=`, "g"), `$1${en}=`);
    // Standard attribute value matching: ="JP" or ='JP'
    clean = clean.replace(new RegExp(`=(["'])${jp}\\1`, "g"), `=$1${en}$1`);
  }

  return clean;
}

