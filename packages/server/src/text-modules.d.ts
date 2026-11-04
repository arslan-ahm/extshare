// Files imported with `with { type: "text" }` are inlined as strings by Bun (and by `bun build`).
declare module "*.sql" {
  const text: string;
  export default text;
}
declare module "*.css" {
  const text: string;
  export default text;
}
