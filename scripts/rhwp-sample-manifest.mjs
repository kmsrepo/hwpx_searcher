export const RHWP_REPO = "https://github.com/edwardkim/rhwp";
export const RHWP_COMMIT = "b3e16ef212af81ef37d973ddb86d6816d3804642";
export const RAW_BASE_URL = `https://raw.githubusercontent.com/edwardkim/rhwp/${RHWP_COMMIT}`;

export const SAMPLES = [
  {
    name: "lseg-01-basic.hwp",
    label: "HWP line segment sample",
    format: "HWP",
    repoPath: "samples/lseg-01-basic.hwp",
    localPath: "samples/rhwp/lseg-01-basic.hwp",
    searchHint: "라인",
  },
  {
    name: "ref_text.hwpx",
    label: "HWPX reference text sample",
    format: "HWPX",
    repoPath: "samples/hwpx/ref/ref_text.hwpx",
    localPath: "samples/rhwp/ref_text.hwpx",
    searchHint: "Hello",
  },
  {
    name: "hwp3-sample.hwp",
    label: "HWP 3.0 legacy sample",
    format: "HWP 3.0",
    repoPath: "samples/hwp3-sample.hwp",
    localPath: "samples/rhwp/hwp3-sample.hwp",
    searchHint: "Virtual Servers",
  },
];
