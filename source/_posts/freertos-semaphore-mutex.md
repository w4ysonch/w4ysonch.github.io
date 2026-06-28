---
title: "FreeRTOS 学习笔记（三）：信号量与互斥锁"
date: 2025-08-15T22:32:12+08:00
categories: ["学习笔记"]
tags: ["FreeRTOS", "RTOS", "嵌入式"]
cover: /images/FreeRTOS_note/image.png
top_img: false
---

信号量和队列是亲戚——信号量本质上就是个不许传数据的队列。它不关心消息内容，只关心"有没有"。

---

**二值信号量（Binary Semaphore）。**

就像一个只能放一个令牌的盒子。任务调用 `xSemaphoreTake()` 拿走令牌，盒子空了；另一个任务（或 ISR）调用 `xSemaphoreGive()` 放回令牌，任务被唤醒。

```c
SemaphoreHandle_t xSemaphoreCreateBinary(void);

// 消费者
if (xSemaphoreTake(sem, portMAX_DELAY) == pdTRUE) {
    // 拿到令牌，干活
}

// 生产者（任务或 ISR）
xSemaphoreGive(sem);              // 任务里用
xSemaphoreGiveFromISR(sem, &woken); // ISR 里用
```

最常见的场景：ISR 通知任务"数据准备好了"。

```c
SemaphoreHandle_t g_data_ready;

// UART 中断：数据收完，通知任务处理
void UART_RxComplete_IRQ(void) {
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(g_data_ready, &woken);
    portYIELD_FROM_ISR(woken);
}

// 任务：等信号量，拿到就处理
void vUARTProcessor(void *pv) {
    while (1) {
        xSemaphoreTake(g_data_ready, portMAX_DELAY);
        ProcessReceivedData();
    }
}
```

---

**计数信号量（Counting Semaphore）。**

和二进制一样，但令牌可以有多个。适合管理有限资源——比如 3 个 DMA 通道：

```c
SemaphoreHandle_t g_dma_sem = xSemaphoreCreateCounting(3, 3);

void vTask(void *pv) {
    // 申请一个 DMA 通道
    if (xSemaphoreTake(g_dma_sem, pdMS_TO_TICKS(100)) == pdTRUE) {
        UseDMA();
        xSemaphoreGive(g_dma_sem); // 用完归还
    } else {
        // 超时，三个通道都在忙
    }
}
```

也适合"积累型"场景：ISR 每触发一次就给一个信号量，任务等到一定次数再处理。

---

**互斥锁（Mutex）。**

看上去跟二值信号量一模一样——都是 Take/Give。但互斥锁多了一个关键机制：**优先级继承**。

```c
SemaphoreHandle_t xSemaphoreCreateMutex(void);
```

优先级继承是这样工作的：

```
Task A (prio 1) 拿到 mutex    →  prio 1
Task B (prio 3) 也想拿 mutex  →  prio 3 阻塞
Task A 被临时提升到 prio 3     ← 这是优先级继承
Task C (prio 2) 不会抢跑       ← 避免了优先级翻转
Task A 释放 mutex，恢复 prio 1
Task B 拿到 mutex
```

如果没有继承机制，Task C（prio 2）会在 A 释放 mutex 之前抢跑，拖延 B 拿到锁的时间——这就是优先级翻转。

---

**互斥锁和递归锁。**

标准互斥锁不能重入：一个任务已经持有它了，再 Take 一次会死锁。

```c
// ❌ 会死锁
void DoSomething(void) {
    xSemaphoreTake(mutex, portMAX_DELAY);
    DoSomethingElse();  // 里面又 Take 同一个 mutex
    xSemaphoreGive(mutex);
}
```

如果确实需要递归（同一任务多次拿锁），用递归锁：

```c
SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(void);
xSemaphoreTakeRecursive(mutex, portMAX_DELAY);    // 可以多次调
xSemaphoreGiveRecursive(mutex);                   // 给几次拿几次必须对等
```

递归锁的典型场景：一个模块的公有函数和私有函数都需要持锁，公有调私有时不会死锁。但尽量少用——需要递归锁通常意味着锁的粒度太大，该拆模块了。

---

实际遇到的一次死锁。

系统里有一个 I2C 总线的 mutex。某天加了一个新功能：温度传感器任务持有 I2C mutex 去读温度，读数异常时调用日志模块打印告警，而日志模块内部也尝试拿 I2C mutex（因为日志输出到 OLED）。

```
TempTask:  Take(I2C_mutex) → ReadTemp() → error → LogError() → Take(I2C_mutex) → 死锁
```

解决方法不是换递归锁，而是把 I2C mutex 拆两层：底层驱动自己管理互斥，上层日志模块不需要知道总线的存在。锁的粒度越小，死锁概率越低。

`configASSERT` 在排查时帮了大忙：

```c
#define configASSERT(x) if(!(x)) { taskDISABLE_INTERRUPTS(); for(;;); }
```

打开后，如果某个 API 返回了预期外的 `pdFALSE`，系统直接停住，调试器一看调用栈就知道死在哪。

---

**信号量 vs 任务通知。**

这是 FreeRTOS 里一个常见的性能选择。任务通知能替代大部分二值信号量的场景，而且更快——通知直接操作 TCB 里的一个字段，不需要创建单独的内核对象。

```c
// 任务通知版（比信号量快 3-5 倍）
xTaskNotifyGive(handle);                  // 发通知
ulTaskNotifyTake(pdTRUE, portMAX_DELAY);  // 等通知

// 信号量版
xSemaphoreGive(sem);
xSemaphoreTake(sem, portMAX_DELAY);
```

但任务通知有几个限制：只能发给指定任务、不能广播、通知值是覆盖式的。当这些限制不构成问题时，直接用任务通知代替二值信号量。

---

**什么时候用什么？**

- 二值信号量：ISR → 任务同步，最简单
- 计数信号量：管理有限资源（DMA 通道、缓冲区槽位）
- 互斥锁：保护共享资源，需要优先级继承
- 递归锁：同一任务需多次拿锁，但尽量少用
- 任务通知：替代二值信号量，更快但有限制
