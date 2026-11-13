#!/usr/bin/env python3
"""Build a small, realistic lecture deck used to test the class-notes plugin.

    python make_demo_pptx.py --output <deck.pptx>

The deck intentionally mixes layouts (title slide, title+body, two content,
a table slide) and puts a pre-existing speaker note on slide 3 so the "merge
around notes the teacher already wrote" path gets exercised.
"""

from __future__ import annotations

import argparse
import sys

from pptx import Presentation
from pptx.util import Inches, Pt


SLIDES = [
    ("title", "第 3 讲  机器学习入门", "数据科学导论 · 2026 秋季"),
    ("content", "什么是机器学习", [
        "让计算机从数据中自动总结规律，而不是由人逐条写死规则",
        "核心三要素：数据、模型、学习算法",
        "Arthur Samuel 1959 年的定义：让程序在下棋中自己变强",
    ]),
    ("content", "监督学习与无监督学习", [
        "监督学习：训练数据带有标签，目标是预测标签",
        "无监督学习：没有标签，目标是发现结构（聚类、降维）",
        "半监督与强化学习是两者的延伸",
    ]),
    ("content", "线性回归", [
        "假设 y = w x + b，用最小二乘法估计参数",
        "损失函数是均方误差 MSE",
        "梯度下降是求解的通用手段",
    ]),
    ("content", "神经网络与反向传播", [
        "多层感知机由输入层、隐藏层、输出层组成",
        "激活函数引入非线性，常用 ReLU 与 Sigmoid",
        "反向传播用链式法则计算梯度",
    ]),
    ("content", "卷积神经网络 CNN", [
        "卷积层提取局部特征，池化层降低分辨率",
        "参数共享大幅减少参数量",
        "在图像分类任务上取得突破",
    ]),
    ("content", "过拟合与正则化", [
        "过拟合：训练集表现好，测试集表现差",
        "L1/L2 正则化限制参数规模",
        "Dropout 与早停是常用的工程手段",
    ]),
    ("content", "课堂练习", [
        "用 sklearn 在 iris 数据集上训练一个逻辑回归",
        "画出混淆矩阵并解释准确率与召回率",
        "下节课讲模型评估与交叉验证",
    ]),
]


def build(path: str) -> None:
    presentation = Presentation()
    presentation.slide_width = Inches(13.333)
    presentation.slide_height = Inches(7.5)

    # Layout 0 is the title slide, layout 1 is title + content.
    for kind, title, *rest in SLIDES:
        if kind == "title":
            slide = presentation.slides.add_slide(presentation.slide_layouts[0])
            slide.shapes.title.text = title
            slide.placeholders[1].text = rest[0]
            continue
        slide = presentation.slides.add_slide(presentation.slide_layouts[1])
        slide.shapes.title.text = title
        body = slide.placeholders[1].text_frame
        body.clear()
        bullets = rest[0]
        for position, bullet in enumerate(bullets):
            paragraph = body.paragraphs[0] if position == 0 else body.add_paragraph()
            paragraph.text = bullet
            paragraph.font.size = Pt(20)

    # A slide with a table, to make sure table cells reach the keyword pass.
    slide = presentation.slides.add_slide(presentation.slide_layouts[5])
    slide.shapes.title.text = "三种学习方式对比"
    table = slide.shapes.add_table(4, 3, Inches(1), Inches(1.8), Inches(10), Inches(3)).table
    table.cell(0, 0).text = "方式"
    table.cell(0, 1).text = "是否需要标签"
    table.cell(0, 2).text = "典型任务"
    rows = [
        ("监督学习", "需要", "分类、回归"),
        ("无监督学习", "不需要", "聚类、降维"),
        ("强化学习", "不需要（用奖励）", "游戏、机器人控制"),
    ]
    for row_index, row in enumerate(rows, start=1):
        for column_index, value in enumerate(row):
            table.cell(row_index, column_index).text = value

    # Pre-existing teacher note: the plugin must keep it, not overwrite it.
    presentation.slides[2].notes_slide.notes_text_frame.text = "上次课留的思考题：为什么要划分测试集？"

    presentation.save(path)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build the demo lecture deck")
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    build(args.output)
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
