import { getElementsToHighlight } from './getElementsToHighlight';
import { wrapHighlightedWords } from './wrapHighlightedWords';
import { toString } from 'hast-util-to-string';
import { hasOwnProperty, isElement } from '../utils';
import { Element } from 'hast';
import type { WordHighlighterOptions } from '../types';
import type { VisitableElement } from '../..';

/**
 * Loops through the child nodes and finds the nodes that make up the word.
 * If the word crosses node boundaries, those nodes are wrapped with
 * <span data-rehype-pretty-code-wrapper/>, and that node is passed to
 * onVisitHighlightedWord.
 *
 * If a node partially matches the word, its content is replaced with the
 * matched part, and the left and/or right parts are cloned to sibling nodes.
 */
export function wordHighlighter(
  element: Element,
  words: string[],
  options: WordHighlighterOptions,
  onVisitHighlightedWord?: (
    element: VisitableElement,
    id: string | undefined
  ) => void
) {
  const { wordNumbers = [] } = options;
  const textContent = toString(element);

  words.forEach((word, index) => {
    if (word && textContent?.includes(word)) {
      let textContent = toString(element);
      let startIndex = 0;

      while (textContent.includes(word)) {
        const currentWordRange = wordNumbers[index] || [];
        const id = `${word}-${index}`;

        options.wordCounter.set(id, (options.wordCounter.get(id) || 0) + 1);

        const ignoreWord =
          currentWordRange.length > 0 &&
          !currentWordRange.includes(options.wordCounter.get(id) ?? -1);

        const elementsToWrap = getElementsToHighlight(
          element,
          word,
          startIndex,
          ignoreWord
        );

        // maybe throw / notify due to failure here
        if (elementsToWrap.length === 0) break;

        wrapHighlightedWords(
          element,
          elementsToWrap,
          options,
          ignoreWord,
          onVisitHighlightedWord
        );

        // re-start from the 'last' node (the word or part of it may exist multiple times in the same node)
        // account for possible extra nodes added from split with - 2
        startIndex = Math.max(
          elementsToWrap[elementsToWrap.length - 1].index - 2,
          0
        );

        textContent = element.children
          ?.map((childNode) => {
            const props = isElement(childNode)
              ? childNode.properties || {}
              : {};
            if (
              !hasOwnProperty(props, 'rehype-pretty-code-visited') &&
              !hasOwnProperty(props, 'data-rehype-pretty-code-wrapper')
            ) {
              return toString(childNode);
            }
          })
          .join('');
      }
    }

    element.children.forEach((childNode) => {
      if (!isElement(childNode)) {
        return;
      }

      if (
        hasOwnProperty(childNode.properties ?? {}, 'rehype-pretty-code-visited')
      ) {
        if (childNode.properties) {
          childNode.properties['rehype-pretty-code-visited'] = undefined;
        }
      }
    });
  });
}
