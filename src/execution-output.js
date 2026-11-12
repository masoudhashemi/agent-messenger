import { StringDecoder } from "node:string_decoder";
export class ExecutionOutput {
  constructor(artifacts, executionId) {
    this.artifacts = artifacts;
    this.ids = {};
    this.decoders = {};
    for (const stream of ["stdout", "stderr"]) {
      this.ids[stream] = artifacts.create({
        label: `${executionId} ${stream}`,
      });
      this.decoders[stream] = new StringDecoder("utf8");
    }
  }
  append(stream, buffer) {
    this.artifacts.append(
      this.ids[stream],
      this.decoders[stream].write(buffer),
    );
  }
  finish() {
    const result = { output_complete: true };
    for (const stream of ["stdout", "stderr"]) {
      const id = this.ids[stream];
      this.artifacts.append(id, this.decoders[stream].end());
      this.artifacts.finish(id);
      const info = this.artifacts.info(id);
      result[stream + "_artifact_id"] = id;
      result[stream + "_characters"] = info.characters;
      const page = this.artifacts.read(id);
      result[stream] = page.complete ? page.text : "";
    }
    return result;
  }
}
