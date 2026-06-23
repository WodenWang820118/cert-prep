from __future__ import annotations

from pathlib import Path
from typing import Any


NPU_PREPASS_MODEL_FILE = "npu-prepass/text-density.onnx"


def prepare_npu_prepass_model(model_dir: Path) -> dict[str, Any]:
    output_path = model_dir / NPU_PREPASS_MODEL_FILE
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        build_text_density_model(output_path)
    except Exception as exc:
        return {
            "state": "failed",
            "reason": str(exc),
            "onnx_file": str(output_path),
        }
    return {
        "state": "ready",
        "model_name": "text_density",
        "onnx_file": str(output_path),
        "relative_path": NPU_PREPASS_MODEL_FILE,
        "purpose": "WindowsML VitisAIExecutionProvider evidence prepass",
    }


def build_text_density_model(output_path: Path) -> None:
    import numpy as np
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    input_tensor = helper.make_tensor_value_info(
        "image",
        TensorProto.FLOAT,
        [1, 3, 32, 32],
    )
    output_tensor = helper.make_tensor_value_info("density", TensorProto.FLOAT, [1, 2])

    conv_weights = np.linspace(-0.2, 0.2, num=4 * 3 * 3 * 3, dtype=np.float32).reshape(
        4,
        3,
        3,
        3,
    )
    conv_bias = np.array([0.01, -0.01, 0.02, -0.02], dtype=np.float32)
    gemm_weights = np.array(
        [
            [0.40, -0.25],
            [-0.30, 0.35],
            [0.20, 0.15],
            [-0.10, 0.25],
        ],
        dtype=np.float32,
    )
    gemm_bias = np.array([0.0, 0.05], dtype=np.float32)

    graph = helper.make_graph(
        [
            helper.make_node(
                "Conv",
                ["image", "conv_w", "conv_b"],
                ["conv_out"],
                kernel_shape=[3, 3],
                pads=[1, 1, 1, 1],
            ),
            helper.make_node("Relu", ["conv_out"], ["relu_out"]),
            helper.make_node("GlobalAveragePool", ["relu_out"], ["pooled"]),
            helper.make_node("Flatten", ["pooled"], ["flat"], axis=1),
            helper.make_node("Gemm", ["flat", "gemm_w", "gemm_b"], ["density"]),
        ],
        "cert_prep_text_density_prepass",
        [input_tensor],
        [output_tensor],
        [
            numpy_helper.from_array(conv_weights, "conv_w"),
            numpy_helper.from_array(conv_bias, "conv_b"),
            numpy_helper.from_array(gemm_weights, "gemm_w"),
            numpy_helper.from_array(gemm_bias, "gemm_b"),
        ],
    )
    model = helper.make_model(
        graph,
        producer_name="cert-prep-windowsml-npu-prepass",
        opset_imports=[helper.make_operatorsetid("", 17)],
    )
    model.ir_version = 10
    onnx.checker.check_model(model)
    onnx.save(model, output_path)
