import hashObj from 'hash-obj';
import type { Element, ElementContent, Root } from 'hast';
import rangeParser from 'parse-numeric-range';
import rehypeParse from 'rehype-parse';
import { Highlighter, getHighlighter as shikiHighlighter } from 'shiki';
import { Transformer, unified } from 'unified';
import { visit } from 'unist-util-visit';
import type { Options, VisitableElement } from '../';
import { WordHighlighterOptions } from './types';
import { isElement, isJSON, isText } from './utils';
import { reverseString } from './word-highlighter/utils';
import { wordHighlighter } from './word-highlighter/wordHighlighter';

interface ToFragmentProps {
  trees: Record<string, Root>;
  lang: string;
  title?: string | null;
  caption?: string | null;
  inline?: boolean;
  keepBackground?: boolean;
  lineNumbersMaxDigits?: number;
}

function toFragment(
  element: Element,
  {
    trees,
    lang,
    title,
    caption,
    inline = false,
    keepBackground = false,
    lineNumbersMaxDigits = 1,
  }: ToFragmentProps
) {
  element.tagName = inline ? 'span' : 'div';
  // User can replace this with a real Fragment at runtime
  element.properties = { 'data-rehype-pretty-code-fragment': '' };
  element.children = Object.entries(trees)
    .map(([mode, tree]) => {
      const pre = tree.children[0];

      if (!isElement(pre) || !pre.properties) {
        return [];
      }

      const code = pre.children[0];

      // Remove class="shiki"
      pre.properties.className = undefined;
      if (!keepBackground) pre.properties = {};

      pre.properties['data-language'] = lang;
      pre.properties['data-theme'] = mode;

      if (!isElement(code) || !code.properties) {
        return [];
      }

      code.properties['data-language'] = lang;
      code.properties['data-theme'] = mode;

      if (inline) {
        if (keepBackground) code.properties['style'] = pre.properties['style'];
        return code;
      }

      if ('data-line-numbers' in code.properties) {
        code.properties['data-line-numbers-max-digits'] =
          lineNumbersMaxDigits.toString().length;
      }

      const fragments: ElementContent[] = [];

      if (title) {
        const elementContent: ElementContent = {
          type: 'element',
          tagName: 'div',
          properties: {
            'data-rehype-pretty-code-title': '',
            'data-language': lang,
            'data-theme': mode,
          },
          children: [{ type: 'text', value: title }],
        };
        fragments.push(elementContent);
      }

      fragments.push(pre);

      if (caption) {
        const elementContent: ElementContent = {
          type: 'element',
          tagName: 'div',
          properties: {
            'data-rehype-pretty-code-caption': '',
            'data-language': lang,
            'data-theme': mode,
          },
          children: [{ type: 'text', value: caption }],
        };
        fragments.push(elementContent);
      }

      return fragments;
    })
    .flatMap((c) => c);
}

const globalHighlighterCache = new Map<
  string,
  Map<string, Promise<Highlighter>>
>();

export default function rehypePrettyCode(
  options: Options = {}
): void | Transformer<Root, Root> {
  const {
    theme,
    keepBackground,
    tokensMap = {},
    filterMetaString = (v) => v,
    onVisitLine,
    onVisitHighlightedLine,
    onVisitHighlightedWord,
    getHighlighter = shikiHighlighter,
  } = options;

  const optionsHash = hashObj(
    {
      theme,
      tokensMap,
      onVisitLine,
      onVisitHighlightedLine,
      onVisitHighlightedWord,
      getHighlighter,
    },
    { algorithm: 'sha1' }
  );
  let highlighterCache = globalHighlighterCache.get(optionsHash);
  if (!highlighterCache) {
    highlighterCache = new Map();
    globalHighlighterCache.set(optionsHash, highlighterCache);
  }
  const highlighters = new Map();
  const hastParser = unified().use(rehypeParse, { fragment: true });

  if (theme == null || typeof theme === 'string' || isJSON(theme)) {
    if (!highlighterCache.has('default')) {
      highlighterCache.set('default', getHighlighter({ theme }));
    }
  } else if (typeof theme === 'object') {
    // color mode object
    for (const [mode, value] of Object.entries(theme)) {
      if (!highlighterCache.has(mode)) {
        highlighterCache.set(mode, getHighlighter({ theme: value }));
      }
    }
  }

  return async (tree) => {
    if (!highlighterCache) return;

    for (const [mode, loadHighlighter] of highlighterCache.entries()) {
      if (!highlighters.get(mode)) {
        highlighters.set(mode, await loadHighlighter);
      }
    }

    visit(tree, 'element', (element, index, parent) => {
      // Inline code
      if (
        (element.tagName === 'code' &&
          isElement(parent) &&
          parent.tagName !== 'pre') ||
        element.tagName === 'inlineCode'
      ) {
        const textElement = element.children[0];

        if (!isText(textElement)) {
          return;
        }

        const value = textElement.value;

        if (!value) {
          return;
        }

        // TODO: allow escape characters to break out of highlighting
        const strippedValue = value.replace(/{:[a-zA-Z.-]+}/, '');
        const meta = value.match(/{:([a-zA-Z.-]+)}$/)?.[1];

        if (!meta) {
          return;
        }

        const isLang = meta[0] !== '.';

        const trees: Record<string, Root> = {};
        for (const [mode, highlighter] of highlighters.entries()) {
          if (!isLang || (meta === 'ansi' && !highlighter.ansiToHtml)) {
            const color =
              highlighter
                .getTheme()
                .settings.find(({ scope }: { scope?: string[] }) =>
                  scope?.includes(tokensMap[meta.slice(1)] ?? meta.slice(1))
                )?.settings.foreground ?? 'inherit';

            trees[mode] = hastParser.parse(
              `<pre><code><span style="color:${color}">${strippedValue}</span></code></pre>`
            );
          } else {
            let html;
            if (meta === 'ansi') {
              html = highlighter.ansiToHtml(strippedValue);
            } else {
              html = highlighter.codeToHtml(strippedValue, meta);
            }
            trees[mode] = hastParser.parse(html);
          }
        }

        toFragment(element, {
          trees,
          lang: isLang ? meta : '.token',
          inline: true,
          keepBackground,
        });
      }

      if (
        // Block code
        // Check from https://github.com/leafac/rehype-shiki
        element.tagName === 'pre' &&
        Array.isArray(element.children) &&
        element.children.length === 1 &&
        isElement(element.children[0]) &&
        element.children[0].tagName === 'code' &&
        typeof element.children[0].properties === 'object' &&
        Array.isArray(element.children[0].properties.className) &&
        typeof element.children[0].properties.className[0] === 'string' &&
        element.children[0].properties.className[0].startsWith('language-')
      ) {
        const codeElement = element.children[0];
        const textElement = codeElement.children[0];

        if (!isElement(codeElement)) {
          return;
        }

        const lang = element.children[0].properties.className[0].replace(
          'language-',
          ''
        );
        const metastring = isElement(codeElement)
          ? (codeElement.data?.meta as string) ??
            (codeElement.properties?.metastring as string) ??
            ''
          : '';

        let meta = filterMetaString(metastring);

        const tiltleMatch = meta.match(/title="([^"]*)"/);
        const title = tiltleMatch?.[1] ?? null;
        meta = meta.replace(tiltleMatch?.[0] ?? '', '');

        const captionMatch = meta.match(/caption="([^"]*)"/);
        const caption = captionMatch?.[1] ?? null;
        meta = meta.replace(captionMatch?.[0] ?? '', '');

        const lineNumbers = meta
          ? rangeParser(meta.match(/(?:^|\s){(.*?)}/)?.[1] ?? '')
          : [];
        let lineNumbersMaxDigits = 0;

        const words: string[] = [];
        const wordNumbers: Array<number[]> = [];
        const wordIdsMap = new Map();

        const wordMatches = meta
          ? [...meta.matchAll(/\/(.*?)\/(\S*)/g)]
          : undefined;
        if (Array.isArray(wordMatches)) {
          wordMatches.forEach((_, index) => {
            const word = wordMatches[index][1];
            const wordIdAndOrRange = wordMatches[index][2];
            words.push(word);

            const [range, id] = wordIdAndOrRange.split('#');

            if (range) {
              wordNumbers.push(rangeParser(range));
            }

            if (id) {
              wordIdsMap.set(word, id);
            }
          });
        }

        if (!isText(textElement)) {
          return;
        }

        const strippedValue = textElement.value.replace(/\n$/, '');
        const trees: Record<string, Root> = {};
        for (const [mode, highlighter] of highlighters.entries()) {
          try {
            let html;
            if (lang === 'ansi' && highlighter.ansiToHtml) {
              html = highlighter.ansiToHtml(strippedValue);
            } else {
              html = highlighter.codeToHtml(strippedValue, lang);
            }
            trees[mode] = hastParser.parse(html);
          } catch (e) {
            // Fallback to plain text if a language has not been registered
            trees[mode] = hastParser.parse(
              highlighter.codeToHtml(strippedValue, 'txt')
            );
          }
        }

        Object.entries(trees).forEach(([, tree]) => {
          let lineCounter = 0;

          const wordOptions: WordHighlighterOptions = {
            wordNumbers,
            wordIdsMap,
            wordCounter: new Map(),
          };

          visit(tree, 'element', (element) => {
            if (
              element.tagName === 'code' &&
              /srebmuNeniLwohs(?!(.*)(\/))/.test(reverseString(meta))
            ) {
              if (element.properties) {
                element.properties['data-line-numbers'] = '';
              }

              const lineNumbersStartAtMatch = reverseString(meta).match(
                /(?:\}(\d+){)?srebmuNeniLwohs(?!(.*)(\/))/
              );
              const startNumberString = lineNumbersStartAtMatch?.[1];
              if (startNumberString) {
                const startAt = startNumberString
                  ? Number(reverseString(startNumberString)) - 1
                  : 0;
                lineNumbersMaxDigits = startAt;
                if (element.properties) {
                  element.properties.style = `counter-set: line ${startAt};`;
                }
              }
            }

            if (
              Array.isArray(element.properties?.className) &&
              element.properties?.className?.[0] === 'line'
            ) {
              onVisitLine?.(element as VisitableElement);

              if (
                lineNumbers.length !== 0 &&
                lineNumbers.includes(++lineCounter)
              ) {
                onVisitHighlightedLine?.(element as VisitableElement);
              }

              wordHighlighter(
                element,
                words,
                wordOptions,
                onVisitHighlightedWord
              );
              lineNumbersMaxDigits++;
            }
          });
        });

        toFragment(element, {
          trees,
          lang,
          title,
          caption,
          keepBackground,
          lineNumbersMaxDigits,
        });
      }
    });
  };
}
