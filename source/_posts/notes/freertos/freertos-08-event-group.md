---
title: "FreeRTOS 学习笔记（八）：事件组"
date: 2025-09-30T16:21:09+08:00
categories: ["笔记"]
tags: ["FreeRTOS", "RTOS", "嵌入式", "学习笔记"]
cover: /images/notes/FreeRTOS_note/image.png
top_img: false
---

信号量和任务通知都是"等一个事件发生"。现实中的场景经常是"等多个条件**同时**满足"——比如"UART 收完一帧数据**而且**定时器已经到期"，或者"三个传感器**任意一个**就绪我就开始融合计算"。

事件组就是干这个的。

它用一个 24 位掩码表示事件（虽然用 `EventBits_t` 传参，实际只有低 24 位可用，高 8 位 FreeRTOS 内部用）。每个位代表一个事件，1 表示发生。

---

创建：

```c
EventGroupHandle_t xEventGroupCreate(void);
// 静态版本
EventGroupHandle_t xEventGroupCreateStatic(StaticEventGroup_t *pxEventGroupBuffer);
```

不需要指定大小——永远是 24 位。

---

设置事件位：

```c
// 任务上下文
EventBits_t xEventGroupSetBits(EventGroupHandle_t xEventGroup,
                                const EventBits_t uxBitsToSet);
// ISR 中用这个
BaseType_t xEventGroupSetBitsFromISR(EventGroupHandle_t xEventGroup,
                                      const EventBits_t uxBitsToSet,
                                      BaseType_t *pxHigherPriorityTaskWoken);
```

"OR" 语义：设完就不管了，已经设的位继续保留，等待的任务看到条件满足会被唤醒。想清掉某些位用 `xEventGroupClearBits`。

---

等待事件：

```c
EventBits_t xEventGroupWaitBits(
    const EventGroupHandle_t xEventGroup,
    const EventBits_t uxBitsToWaitFor,   // 等哪些位
    const BaseType_t xClearOnExit,       // pdTRUE=拿到后自动清掉
    const BaseType_t xWaitForAllBits,    // pdTRUE=AND, pdFALSE=OR
    TickType_t xTicksToWait
);
```

`xWaitForAllBits` 是关键参数：
- `pdTRUE`：**AND**——所有指定的位都置 1 才返回
- `pdFALSE`：**OR**——任意一个指定的位置 1 就返回

`xClearOnExit`：`pdTRUE` 返回前自动清掉等过的位（原子操作），不会丢中间发生的事件。

---

例子：等三个传感器都就绪再开始融合。

```c
#define BIT_ACCEL_READY  (1 << 0)
#define BIT_GYRO_READY   (1 << 1)
#define BIT_MAG_READY    (1 << 2)
#define ALL_SENSORS (BIT_ACCEL_READY | BIT_GYRO_READY | BIT_MAG_READY)

EventGroupHandle_t g_sensor_events;

void vAccelTask(void *pv) {
    while (1) {
        ReadAccel();
        xEventGroupSetBits(g_sensor_events, BIT_ACCEL_READY);
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void vGyroTask(void *pv) {
    while (1) {
        ReadGyro();
        xEventGroupSetBits(g_sensor_events, BIT_GYRO_READY);
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void vMagTask(void *pv) {
    while (1) {
        ReadMag();
        xEventGroupSetBits(g_sensor_events, BIT_MAG_READY);
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void vFusionTask(void *pv) {
    while (1) {
        // 等三个传感器全部就绪
        EventBits_t bits = xEventGroupWaitBits(
            g_sensor_events, ALL_SENSORS, pdTRUE, pdTRUE, pdMS_TO_TICKS(20)
        );

        if ((bits & ALL_SENSORS) == ALL_SENSORS) {
            FuseSensorData();  // 三个都拿到了，做融合
        } else {
            // 20ms 超时——有传感器可能挂了
            LogSensorTimeout(bits);
        }
    }
}
```

三个传感器各自独立采集，融合任务等三者全部就绪。注意 `xClearOnExit=pdTRUE`——返回后自动清零，不用手动清。

---

例子：任意一个中断唤醒任务。

```c
void UART_Rx_ISR(void) { xEventGroupSetBitsFromISR(g_events, BIT_UART, &woken); }
void TIM_ISR(void)    { xEventGroupSetBitsFromISR(g_events, BIT_TIMER, &woken); }
void EXTI_ISR(void)   { xEventGroupSetBitsFromISR(g_events, BIT_BUTTON, &woken); }

void vEventHandlerTask(void *pv) {
    while (1) {
        EventBits_t bits = xEventGroupWaitBits(
            g_events, BIT_UART | BIT_TIMER | BIT_BUTTON,
            pdTRUE,   // 清掉等过的
            pdFALSE,  // OR：任意一个就醒
            portMAX_DELAY
        );
        if (bits & BIT_UART)   HandleUART();
        if (bits & BIT_TIMER)  HandleTimer();
        if (bits & BIT_BUTTON) HandleButton();
    }
}
```

一个任务等三个 ISR，拿到后分别处理。

---

事件组和信号量/任务通知的区别。

| | 事件组 | 信号量 | 任务通知 |
|------|------|------|------|
| 等条件 | 多事件 AND/OR | 单事件 | 单事件 |
| ISR 安全 | ✅ FromISR | ✅ | ✅ |
| 能传数据 | ❌ 只有位 | ❌ | ✅ 32位 |
| 广播 | ✅ 多任务等同一组 | ❌ | ❌ 单任务 |
| 内存开销 | 创建 EventGroup 对象 | 创建 Semaphore | 零（TCB 自带） |

事件组的特殊限制：**ISR 里只能用 `SetBits`，不能 Wait**。等待事件必须由任务完成。

---

多个任务等同一组事件。

事件组支持多个任务同时等同一组事件：

```c
// 三个任务都在等网络状态
xEventGroupWaitBits(g_net_events, BIT_LINK_UP, pdTRUE, pdFALSE, portMAX_DELAY);
// 网络链路恢复后，三个任务同时被唤醒
```

信号量做不到这点——信号量被一个任务 Take 走就没了。但注意 `xClearOnExit=pdTRUE` 时只有一个任务能拿到清掉后的结果，其他任务可能看到已经被清掉的状态。如果希望"所有人同时收到事件"，用 `xClearOnExit=pdFALSE`，事件位不清，所有等待任务都能看到。

---

同步屏障（Barrier）。

用事件组实现多任务同步点——所有任务都到达某个点后才一起继续：

```c
#define BIT_TASK1_DONE (1 << 0)
#define BIT_TASK2_DONE (1 << 1)
#define BIT_TASK3_DONE (1 << 2)
#define ALL_DONE (BIT_TASK1_DONE | BIT_TASK2_DONE | BIT_TASK3_DONE)

EventGroupHandle_t g_barrier;

void vWorkerTask(void *pv) {
    int id = (int)pv;
    EventBits_t my_bit = 1 << id;

    while (1) {
        // 各自干活
        DoPhase1Work(id);

        // 到达屏障——报告自己完成
        xEventGroupSetBits(g_barrier, my_bit);

        // 等所有人都到
        xEventGroupWaitBits(g_barrier, ALL_DONE, pdTRUE, pdTRUE, portMAX_DELAY);

        // 大家一起进 Phase2
        DoPhase2Work(id);
    }
}
```

三个任务并行做完 Phase1，全部到达屏障后才一起进 Phase2。`pdTRUE` 清掉后重新计数。

---

24 位限制。

`EventBits_t` 是 `TickType_t` 的别名，32 位，但 FreeRTOS 保留了高 8 位。能用的事件位只有 24 个（位 0~23）。所以当你有超过 24 个事件时需要考虑用多个事件组，或者用队列集。

---

性能。

事件组操作比队列快（不需要拷贝数据），但比任务通知慢（需要创建独立的内核对象）。创建 EventGroup 对象跟创建信号量开销相当。

8 个事件以内，事件组是非常高效的多条件等待方案。超过 24 个事件就要拆分设计了。
