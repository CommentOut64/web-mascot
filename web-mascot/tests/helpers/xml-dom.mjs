export class StackDOMParser {
    parseFromString(xmlText) {
      const clean = xmlText.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[^>]*\?>/g, "").trim();
      const tagRegex = /<([a-zA-Z0-9_\-:]+)((?:\s+[^>]*)?)\s*(\/?>)|<\/([a-zA-Z0-9_\-:]+)\s*>/g;
      let root = null;
      const stack = [];
      let match;

      while ((match = tagRegex.exec(clean)) !== null) {
        const isCloseTag = !!match[4];
        if (isCloseTag) {
          const closeTagName = match[4];
          if (stack.length > 0 && (stack[stack.length - 1].tagName === closeTagName || stack[stack.length - 1].localName === closeTagName)) {
            stack.pop();
          }
          continue;
        }

        const tagName = match[1];
        let attrStr = match[2] || "";
        const isSelfClosing = match[3] === "/>" || attrStr.trimEnd().endsWith("/");
        if (attrStr.trimEnd().endsWith("/")) {
          attrStr = attrStr.trimEnd().slice(0, -1);
        }
        const localName = tagName.includes(":") ? tagName.split(":")[1] : tagName;

        const map = new Map();
        const items = [];
        const re = /([a-zA-Z0-9_\-:]+)=["']([^"']*)["']/g;
        let m;
        while ((m = re.exec(attrStr)) !== null) {
          const value = m[2].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
          map.set(m[1], value);
          items.push({ name: m[1], value });
        }
        const attrs = { length: items.length, item: (i) => items[i] || null, get: (k) => map.get(k) ?? null };

        const elem = {
          tagName,
          localName,
          attributes: attrs,
          children: [],
          childNodes: [],
          getAttribute: (k) => attrs.get(k),
          getElementsByTagName: function (name) {
            const list = [];
            function scan(e) {
              for (const ch of e.children) {
                if (name === "*" || ch.tagName === name || ch.localName === name) list.push(ch);
                scan(ch);
              }
            }
            scan(this);
            return list;
          },
          getElementsByTagNameNS: function (ns, name) {
            return this.getElementsByTagName(name);
          },
        };

        if (!root) root = elem;
        if (stack.length > 0) {
          elem.parentNode = stack[stack.length - 1];
          stack[stack.length - 1].children.push(elem);
          stack[stack.length - 1].childNodes.push(elem);
        }
        if (!isSelfClosing) stack.push(elem);
      }

      return {
        documentElement: root,
        getElementsByTagName: (name) => {
          const list = [];
          if (root) {
            if (name === "*" || root.tagName === name || root.localName === name) list.push(root);
            list.push(...root.getElementsByTagName(name));
          }
          return list;
        },
        getElementsByTagNameNS: (ns, name) => root ? root.getElementsByTagName(name) : [],
      };
    }
  }
