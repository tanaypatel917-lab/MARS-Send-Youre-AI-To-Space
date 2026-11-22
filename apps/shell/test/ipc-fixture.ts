export function ipcFixture() {
  const trustedOrigin = "mars-shell://app";
  const mainFrame = { url: `${trustedOrigin}/index.html` };
  const trustedContents = { mainFrame };
  const otherContents = { mainFrame: { ...mainFrame } };
  return {
    options: { trustedOrigin, trustedContents },
    owner: { sender: trustedContents, senderFrame: mainFrame },
    otherWindow: {
      sender: otherContents,
      senderFrame: otherContents.mainFrame,
    },
    childFrame: { sender: trustedContents, senderFrame: { ...mainFrame } },
  };
}
