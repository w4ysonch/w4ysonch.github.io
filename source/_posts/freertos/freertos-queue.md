---
title: "FreeRTOS 学习笔记（二）：队列"
date: 2025-08-12T19:21:34+08:00
categories: ["FreeRTOS"]
tags: ["FreeRTOS", "RTOS", "嵌入式"]
cover: /images/FreeRTOS_note/image.png
top_img: false
---

任务之间怎么传数据？最简单的办法是全局变量。但全局变量没有"阻塞等待"能力——消费者不知道数据什么时候准备好，只能轮询。

队列解决了这个问题：生产者往里面放，消费者从里面取。如果队列空了，消费者可以选择阻塞等待。

它本质上是个先进先出的缓冲区，但多了任务间同步的能力。

---

创建队列：

```c
QueueHandle_t xQueueCreate(
    UBaseType_t uxQueueLength,   // 最多存几条消息
    UBaseType_t uxItemSize       // 每条消息多大
);
```

注意：`uxItemSize` 是**每条**消息的大小，不是总大小。队列的实际内存 = `uxQueueLength * uxItemSize`，这块内存由 FreeRTOS 从堆上分配。

如果不想用堆，可以用 `xQueueCreateStatic()`，自己提供 `uint8_t` 缓冲区。

---

发送：

```c
BaseType_t xQueueSend(
    QueueHandle_t xQueue,
    const void *  pvItemToQueue,
    TickType_t    xTicksToWait   // 满时最多等多久，0 = 不等，portMAX_DELAY = 死等
);
```

数据是**拷贝进去**的，不是传指针——队列把你传入的 `pvItemToQueue` 所指的内存内容 `memcpy` 到内部缓冲区。所以 `pvItemToQueue` 可以指向局部变量，不用担心作用域问题。

除了 `xQueueSend`，还有几个变体：

```c
xQueueSendToBack()   // 跟 xQueueSend 一样，放队尾
xQueueSendToFront()  // 插队到队首（紧急消息用）
xQueueOverwrite()    // 覆盖式发送，即使队列满了也写（适合只有一条最新数据的场景）
```

---

接收：

```c
BaseType_t xQueueReceive(
    QueueHandle_t xQueue,
    void *        pvBuffer,      // 读出来的数据放这里
    TickType_t    xTicksToWait   // 空时最多等多久
);
```

读完后数据从队列里**移除**。如果想"只看不拿走"，用 `xQueuePeek()`：

```c
xQueuePeek(queue, &buf, timeout);  // 看一眼，数据还在队列里
```

---

一个发一个收的例子：

```c
// 生产者任务：每 200ms 产生一个传感器数据
QueueHandle_t g_sensor_queue;

typedef struct {
    float temperature;
    int   humidity;
} sensor_data_t;

void vSensorTask(void *pv) {
    sensor_data_t data;
    while (1) {
        data.temperature = 25.0f + (rand() % 50) * 0.1f;
        data.humidity    = 55 + rand() % 20;
        xQueueSend(g_sensor_queue, &data, portMAX_DELAY);
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}

// 消费者任务：收到数据后处理
void vDisplayTask(void *pv) {
    sensor_data_t data;
    while (1) {
        if (xQueueReceive(g_sensor_queue, &data, portMAX_DELAY) == pdTRUE) {
            printf("温度: %.1f°C  湿度: %d%%\r\n",
                   data.temperature, data.humidity);
        }
    }
}

int main(void) {
    g_sensor_queue = xQueueCreate(10, sizeof(sensor_data_t));
    xTaskCreate(vSensorTask,  "Sensor",  256, NULL, 2, NULL);
    xTaskCreate(vDisplayTask, "Display", 256, NULL, 1, NULL);
    vTaskStartScheduler();
    while (1);
}
```

队列里有 10 个坑位，生产速度 200ms，消费能力足够快就不会满。

---

**队列满了怎么办？**

取决于业务：

- 如果旧数据没意义（传感器读数），用 `xQueueOverwrite()`，只保留最新的
- 如果数据不能丢（日志、命令），增加队列长度或者提高消费者优先级
- 如果偶尔丢几帧可以接受，用 `xQueueSend()` + 超时 0，满了直接返回 `errQUEUE_FULL`，跳过这次发送

---

**ISR 里发队列的坑。**

在中断服务函数里不能调 `xQueueSend`——因为它可能阻塞，而 ISR 里不能阻塞。必须用 FromISR 版本：

```c
BaseType_t xQueueSendFromISR(
    QueueHandle_t xQueue,
    const void *  pvItemToQueue,
    BaseType_t *  pxHigherPriorityTaskWoken  // 关键参数
);
```

`pxHigherPriorityTaskWoken` 是个标志位——如果发送后唤醒了一个更高优先级的任务，它会被设为 `pdTRUE`。然后你在 ISR 末尾调用 `portYIELD_FROM_ISR()` 触发一次上下文切换：

```c
// UART 接收中断
void UART_Rx_IRQHandler(void) {
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;
    uint8_t byte = UART->DR;

    xQueueSendFromISR(g_uart_queue, &byte, &xHigherPriorityTaskWoken);

    portYIELD_FROM_ISR(xHigherPriorityTaskWoken);
}
```

忘了检查这个标志位，结果是：消息发出去了，但消费者要等到下一个 tick 才会被调度——延迟一个 tick（1ms~10ms），对高实时场景可能刚好超时。

---

**队列 vs 全局数组的实测对比。**

在 STM32F407（168MHz）上做了个简单对比，单字节消息、发 10000 次：

```
全局数组（轮询）:  平均 0.3μs/次，无阻塞能力，消费者忙等
队列（1个坑位）:   平均 2.1μs/次，支持阻塞等待
队列（32个坑位）:  平均 2.8μs/次，队列越长开销越大（拷贝 + 索引计算）
```

队列慢了一个数量级，但这几微秒换来了阻塞等待能力和任务解耦——值不值取决于场景。传感器数据轮询够用了，网络协议栈就必须上队列。

另外队列创建时的 `uxItemSize` 越小越好。大结构体优先传指针：

```c
// ❌ 大结构体拷贝
xQueueCreate(8, sizeof(net_packet_t));  // 一条消息 516 字节

// ✅ 只传指针
xQueueCreate(8, sizeof(net_packet_t *));  // 一条消息 4 字节
```

传指针的话要自己管理 `net_packet_t` 的生命周期——被消费之前不能释放。通常用内存池配合队列，消费者取走指针、用完归还。

---

**阻塞超时的小细节。**

`portMAX_DELAY` 的意思是"等到天荒地老"。但如果用了 `vTaskSuspendAll()` 关了调度器，即使队列里有数据也不会被唤醒——调度器关了，任务切换不生效。

所以调试时如果发现任务卡在某个 `portMAX_DELAY` 上永远不动了，先检查是不是哪里关了调度器忘了开。
