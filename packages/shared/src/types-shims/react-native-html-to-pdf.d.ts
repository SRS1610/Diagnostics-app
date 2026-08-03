// Ambient type declaration for a React Native-only native module.
// packages/shared is consumed both by the RN mobile app (where the real
// package is installed) and by packages/api (a Node/Express package,
// where it never runs) — this shim lets the shared package type-check
// in both contexts without adding a native-only dependency to the API.
declare module "react-native-html-to-pdf" {
  interface Options {
    html: string;
    fileName?: string;
    directory?: string;
    base64?: boolean;
  }
  interface ConversionResult {
    filePath?: string;
    base64?: string;
  }
  const RNHTMLtoPDF: {
    convert(options: Options): Promise<ConversionResult>;
  };
  export default RNHTMLtoPDF;
}
