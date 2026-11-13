/**
 * The synthetic lecture used by the tests: what the recognizer would hand back,
 * page by page, five seconds per line. Each page has three lines so the
 * confirmation window gets a fair chance, exactly like a real lecture.
 *
 * `[expectedSlide, spokenLine]`
 */
export const LECTURE = [
  [2, '今天我们讲什么是机器学习'],
  [2, '机器学习是从数据里自动总结规律'],
  [2, 'Arthur Samuel 在 1959 年给出的定义是让程序在下棋中自己变强'],
  [3, '接下来看监督学习和无监督学习的区别'],
  [3, '监督学习的训练数据带有标签，目标是预测标签'],
  [3, '无监督学习没有标签，目标是发现结构，比如聚类和降维'],
  [4, '我们再看线性回归，假设 y 等于 w x 加 b'],
  [4, '线性回归用最小二乘法估计参数'],
  [4, '损失函数是均方误差 MSE，梯度下降是求解的通用手段'],
  [5, '然后是神经网络与反向传播'],
  [5, '多层感知机由输入层、隐藏层和输出层组成'],
  [5, '激活函数引入非线性，反向传播用链式法则计算梯度'],
  [6, '卷积神经网络 CNN 在图像分类里最常用'],
  [6, '卷积层提取局部特征，池化层降低分辨率'],
  [6, '参数共享大幅减少参数量'],
  [7, '下面说过拟合与正则化'],
  [7, '过拟合是训练集表现好测试集表现差'],
  [7, 'L1 和 L2 正则化限制参数规模，Dropout 和早停也是常用的工程手段'],
  [8, '最后是课堂练习'],
  [8, '用 sklearn 在 iris 数据集上训练一个逻辑回归'],
  [8, '画出混淆矩阵并解释准确率和召回率'],
]
